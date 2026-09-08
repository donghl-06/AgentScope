import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  StoredEvent,
  StoredObserverEvidence,
  StoredSession,
  StoredTurn,
} from '@agentscope/storage';
import type { ProviderTelemetry } from '@agentscope/protocol';

import { DashboardApi, type DashboardLiveNotification } from './api.js';
import { evidenceBelongsToTurn, evidencePayloadSummary } from './evidence.js';
import { formatDuration, formatTimestamp, statusLabel } from './format.js';
import { loadAllPages } from './pagination.js';
import { hasTimelineGap, lastTimelineSeq, mergeTimelineEvents } from './timeline.js';

const api = new DashboardApi();
type NotificationState = NotificationPermission | 'unsupported' | 'requesting' | 'unavailable';
const NOTIFIABLE_SESSION_STATUSES = new Set(['blocked', 'completed', 'failed', 'interrupted']);

export function App() {
  const [sessions, setSessions] = useState<readonly StoredSession[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<StoredSession>();
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [turns, setTurns] = useState<readonly StoredTurn[]>([]);
  const [evidence, setEvidence] = useState<readonly StoredObserverEvidence[]>([]);
  const [eventsNextCursor, setEventsNextCursor] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<'all' | StoredSession['status']>('all');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'offline'>(
    'connecting',
  );
  const [notificationState, setNotificationState] = useState<NotificationState>(() =>
    typeof globalThis.Notification === 'undefined'
      ? 'unsupported'
      : globalThis.Notification.permission,
  );
  const selectedIdRef = useRef<string | undefined>(undefined);
  const lastSeqBySessionRef = useRef(new Map<string, number>());
  const notificationStateRef = useRef(notificationState);
  const notificationRequestRef = useRef(0);
  const notificationKeysRef = useRef(new Set<string>());
  const notificationBaselineReadyRef = useRef(false);

  useEffect(() => {
    notificationStateRef.current = notificationState;
  }, [notificationState]);

  const refreshSessions = useCallback(async () => {
    try {
      const page = await api.listSessions({ limit: 100 });
      setSessions(page.items);
      if (!notificationBaselineReadyRef.current) {
        for (const session of page.items) {
          notificationKeysRef.current.add(`session.updated:${session.id}:${session.status}`);
        }
        notificationBaselineReadyRef.current = true;
      }
      setError(undefined);
      setSelectedId((current) => current ?? page.items[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  const enableNotifications = useCallback(() => {
    if (typeof globalThis.Notification === 'undefined') {
      setNotificationState('unsupported');
      return;
    }
    if (globalThis.Notification.permission === 'granted') {
      setNotificationState('granted');
      return;
    }

    const requestId = ++notificationRequestRef.current;
    let settled = false;
    const finish = (state: NotificationState) => {
      if (settled || notificationRequestRef.current !== requestId) return;
      settled = true;
      clearTimeout(timeoutId);
      setNotificationState(state);
    };

    setNotificationState('requesting');
    const timeoutId = setTimeout(() => finish('unavailable'), 8_000);
    void Promise.resolve()
      .then(() => globalThis.Notification.requestPermission())
      .then(finish, () => finish('unavailable'));
  }, []);

  const notifyLiveStatus = useCallback((message: DashboardLiveNotification) => {
    const rawStatus = message.payload?.status;
    if (typeof rawStatus !== 'string') return;
    const isTurnWaiting = message.type === 'turn.updated' && rawStatus === 'waiting';
    if (!isTurnWaiting && !NOTIFIABLE_SESSION_STATUSES.has(rawStatus)) return;
    if (
      notificationStateRef.current !== 'granted' ||
      typeof globalThis.Notification === 'undefined'
    ) {
      return;
    }
    const id = message.sessionId ?? 'unknown-session';
    const key = `${message.type}:${id}:${rawStatus}`;
    if (notificationKeysRef.current.has(key)) return;
    notificationKeysRef.current.add(key);
    const label = isTurnWaiting ? 'Turn waiting for input' : `Session ${statusLabel(rawStatus)}`;
    try {
      new globalThis.Notification(`AgentScope · ${label}`, {
        body: `Session ${id.slice(0, 8)} received a new status signal.`,
        tag: key,
      });
    } catch {
      // Browser notification failures must never affect live monitoring.
    }
  }, []);

  const refreshDetail = useCallback(async (id: string, after?: number) => {
    setDetailLoading(true);
    try {
      const [session, page, observerEvidence, sessionTurns] = await Promise.all([
        api.getSession(id),
        api.listEvents(id, after ?? 0),
        loadAllPages((cursor) =>
          api.listObserverEvidencePage(id, {
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
        loadAllPages((cursor) =>
          api.listTurnPage(id, {
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ]);
      setSelected(session);
      setEvidence(observerEvidence);
      setTurns(sessionTurns);
      if (after === undefined) {
        setEvents(page.items);
        lastSeqBySessionRef.current.set(id, lastTimelineSeq(page.items));
      } else {
        setEvents((current) => {
          const merged = mergeTimelineEvents(current, page.items);
          lastSeqBySessionRef.current.set(id, lastTimelineSeq(merged));
          return merged;
        });
      }
      setEventsNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load session details.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let stopped = false;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== undefined) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      setConnectionState('connecting');
      try {
        socket = api.connectLive((message: DashboardLiveNotification) => {
          notifyLiveStatus(message);
          if (message.type === 'session.created' || message.type === 'session.updated') {
            void refreshSessions();
          }
          if (message.type === 'event.appended') {
            void refreshSessions();
            if (message.sessionId !== undefined && message.sessionId === selectedIdRef.current) {
              const lastSeq = lastSeqBySessionRef.current.get(message.sessionId) ?? 0;
              if (message.seq === undefined || message.seq > lastSeq) {
                if (
                  message.seq === undefined ||
                  hasTimelineGap(lastSeq, message.seq) ||
                  message.seq === lastSeq + 1
                ) {
                  void refreshDetail(message.sessionId, lastSeq);
                }
              }
            }
          }
          if (
            (message.type === 'turn.created' ||
              message.type === 'turn.updated' ||
              message.type === 'turn.finished') &&
            message.sessionId === selectedIdRef.current
          ) {
            const sessionId = message.sessionId;
            if (sessionId === undefined) return;
            void refreshDetail(sessionId, lastSeqBySessionRef.current.get(sessionId) ?? 0);
          }
        });
        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          setConnectionState('connected');
          const selectedSessionId = selectedIdRef.current;
          if (selectedSessionId !== undefined) {
            void refreshDetail(
              selectedSessionId,
              lastSeqBySessionRef.current.get(selectedSessionId) ?? 0,
            );
          }
        });
        socket.addEventListener('close', () => {
          setConnectionState('offline');
          scheduleReconnect();
        });
        socket.addEventListener('error', () => setConnectionState('offline'));
      } catch {
        setConnectionState('offline');
        scheduleReconnect();
      }
    };

    void refreshSessions().finally(() => {
      if (!stopped) connect();
    });
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [notifyLiveStatus, refreshDetail, refreshSessions]);

  useEffect(() => {
    if (selectedId !== undefined) void refreshDetail(selectedId);
  }, [refreshDetail, selectedId]);

  const counts = useMemo(() => {
    const count = (status: string) =>
      sessions.filter((session) => session.status === status).length;
    return {
      active: count('starting') + count('running'),
      blocked: count('blocked'),
      completed: count('completed'),
      failed: count('failed'),
    };
  }, [sessions]);

  const visibleSessions = useMemo(
    () =>
      statusFilter === 'all'
        ? sessions
        : sessions.filter((session) => session.status === statusFilter),
    [sessions, statusFilter],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL-FIRST OBSERVABILITY</p>
          <h1>AgentScope</h1>
          <p className="subtitle">A calm, evidence-based view of coding-agent work.</p>
        </div>
        <div className={`connection connection-${connectionState}`}>
          <span className="connection-dot" />
          {connectionState === 'connected'
            ? 'Live updates connected'
            : connectionState === 'connecting'
              ? 'Connecting to server'
              : 'Offline · retrying'}
        </div>
        <NotificationControl state={notificationState} onEnable={enableNotifications} />
      </header>

      {error !== undefined && <div className="banner banner-error">{error}</div>}

      <section className="stat-grid" aria-label="Session summary">
        <Stat label="Active" value={counts.active} tone="blue" />
        <Stat label="Blocked" value={counts.blocked} tone="amber" />
        <Stat label="Completed" value={counts.completed} tone="green" />
        <Stat label="Failed" value={counts.failed} tone="red" />
      </section>

      <section className="content-grid">
        <div className="panel sessions-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SESSIONS</p>
              <h2>Recent agent work</h2>
            </div>
            <div className="panel-actions">
              <label className="filter-label">
                <span className="sr-only">Filter sessions by status</span>
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | StoredSession['status'])
                  }
                >
                  <option value="all">All statuses</option>
                  <option value="starting">Starting</option>
                  <option value="running">Running</option>
                  <option value="blocked">Blocked</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="interrupted">Interrupted</option>
                </select>
              </label>
              <button
                className="quiet-button"
                type="button"
                onClick={() => void refreshSessions()}
                disabled={loading}
              >
                Refresh
              </button>
            </div>
          </div>
          {loading ? (
            <p className="empty-state">Loading sessions…</p>
          ) : visibleSessions.length === 0 ? (
            <p className="empty-state">No sessions recorded yet.</p>
          ) : (
            <div className="session-list">
              {visibleSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={selectedId === session.id}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          )}
        </div>

        <div className="panel detail-panel">
          {selected === undefined ? (
            <p className="empty-state">Select a session to inspect its evidence timeline.</p>
          ) : (
            <SessionDetail
              session={selected}
              sessions={sessions}
              events={events}
              turns={turns}
              evidence={evidence}
              eventsNextCursor={eventsNextCursor}
              loading={detailLoading}
              onSelectSession={setSelectedId}
              onLoadMore={() =>
                void refreshDetail(selected.id, lastSeqBySessionRef.current.get(selected.id) ?? 0)
              }
            />
          )}
        </div>
      </section>
    </main>
  );
}

function NotificationControl({
  state,
  onEnable,
}: {
  state: NotificationState;
  onEnable: () => void;
}) {
  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return <span className="notification-status">Notifications enabled</span>;
  }
  if (state === 'denied') {
    return <span className="notification-status">Notifications blocked by browser</span>;
  }
  if (state === 'unavailable') {
    return (
      <div className="notification-control" role="status">
        <span className="notification-status notification-status-warning">
          Permission prompt unavailable
        </span>
        <button
          className="quiet-button quiet-button-small"
          type="button"
          onClick={onEnable}
          title="Retry in a browser that supports notification permission prompts"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <button
      className="quiet-button quiet-button-small"
      type="button"
      onClick={onEnable}
      disabled={state === 'requesting'}
    >
      {state === 'requesting' ? 'Requesting…' : 'Enable notifications'}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: StoredSession;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`session-row ${selected ? 'session-row-selected' : ''}`}
      type="button"
      onClick={() => onSelect(session.id)}
    >
      <span className={`status-dot status-${session.status}`} />
      <span className="session-row-copy">
        <strong>
          {session.provider} · {session.adapter}
        </strong>
        <small>{session.id}</small>
      </span>
      <span className={`status-pill status-pill-${session.status}`}>
        {statusLabel(session.status)}
      </span>
    </button>
  );
}

function SessionDetail({
  session,
  sessions,
  events,
  turns,
  evidence,
  eventsNextCursor,
  loading,
  onSelectSession,
  onLoadMore,
}: {
  session: StoredSession;
  sessions: readonly StoredSession[];
  events: readonly StoredEvent[];
  turns: readonly StoredTurn[];
  evidence: readonly StoredObserverEvidence[];
  eventsNextCursor: string | undefined;
  loading: boolean;
  onSelectSession: (id: string) => void;
  onLoadMore: () => void;
}) {
  const [timelineQuery, setTimelineQuery] = useState('');
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'turn' | 'native' | 'observer'>(
    'all',
  );
  const normalizedQuery = timelineQuery.trim().toLocaleLowerCase();
  const visibleEvents = events.filter(({ event }) => {
    if (timelineFilter === 'turn' && !event.type.startsWith('turn_')) return false;
    if (
      timelineFilter === 'native' &&
      !(
        event.type === 'provider_event' ||
        event.type === 'provider_info' ||
        event.type === 'usage_updated' ||
        event.type.startsWith('tool_call_') ||
        event.type.startsWith('milestone_')
      )
    ) {
      return false;
    }
    if (timelineFilter === 'observer' && event.type !== 'observer_activity') return false;
    if (normalizedQuery === '') return true;
    const detail = eventDetail(event) ?? '';
    return `${event.type} ${detail}`.toLocaleLowerCase().includes(normalizedQuery);
  });
  const hasTimelineFilter = timelineFilter !== 'all' || normalizedQuery !== '';
  return (
    <>
      <div className="panel-heading detail-heading">
        <div>
          <p className="eyebrow">SESSION DETAIL</p>
          <h2>{session.provider} session</h2>
        </div>
        <span className={`status-pill status-pill-${session.status}`}>
          {statusLabel(session.status)}
        </span>
      </div>
      <div className="detail-meta">
        <span>
          <b>Started</b>
          {formatTimestamp(session.startedAt)}
        </span>
        <span>
          <b>Duration</b>
          {formatDuration(session.startedAt, session.endedAt)}
        </span>
        <span>
          <b>Workspace</b>
          {workspaceLabel(session.workspace)}
        </span>
      </div>
      <AgentCard session={session} events={events} />
      <ConversationGroupDetails
        session={session}
        sessions={sessions}
        onSelectSession={onSelectSession}
      />
      <TurnList turns={turns} evidence={evidence} events={events} />
      <div className="evidence-card">
        <span className="eyebrow">ACTIVITY</span>
        <strong>{session.state.currentActivity?.label ?? 'No activity signal'}</strong>
        <small>
          {session.state.progress.reasons[0]?.message ?? 'No progress explanation available.'}
        </small>
      </div>
      <div className="evidence-card">
        <span className="eyebrow">OBSERVER EVIDENCE</span>
        <strong>{evidence.length} signals</strong>
        <small>{observerEvidenceSummary(evidence)}</small>
      </div>
      <div className="timeline-heading">
        <h3>Timeline</h3>
        <div className="timeline-actions">
          <label className="timeline-search-label">
            <span className="sr-only">Search loaded timeline events</span>
            <input
              className="timeline-search"
              value={timelineQuery}
              onChange={(event) => setTimelineQuery(event.target.value)}
              placeholder="Search timeline"
              type="search"
            />
          </label>
          <label className="filter-label">
            <span className="sr-only">Filter timeline events</span>
            <select
              value={timelineFilter}
              onChange={(event) =>
                setTimelineFilter(event.target.value as 'all' | 'turn' | 'native' | 'observer')
              }
            >
              <option value="all">All events</option>
              <option value="turn">Turn boundaries</option>
              <option value="native">Provider events</option>
              <option value="observer">Observer activity</option>
            </select>
          </label>
          <span>
            {loading
              ? 'Refreshing…'
              : hasTimelineFilter
                ? `${visibleEvents.length} / ${events.length} events`
                : `${events.length} events`}
          </span>
          {eventsNextCursor !== undefined && (
            <button
              className="quiet-button quiet-button-small"
              type="button"
              onClick={onLoadMore}
              disabled={loading}
            >
              Load more
            </button>
          )}
        </div>
      </div>
      {visibleEvents.length === 0 ? (
        <p className="empty-state">
          {events.length === 0
            ? 'No events recorded.'
            : 'No loaded timeline events match this filter.'}
        </p>
      ) : (
        <ol className="timeline">
          {visibleEvents.map(({ seq, event }) => (
            <li key={event.id}>
              <span className="timeline-seq">{seq}</span>
              <div>
                <strong>{statusLabel(event.type)}</strong>
                <small>
                  {formatTimestamp(event.timestamp)} · confidence{' '}
                  {Math.round(event.confidence * 100)}%
                </small>
                {eventDetail(event) !== undefined && <small>{eventDetail(event)}</small>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function TurnList({
  turns,
  evidence,
  events,
}: {
  turns: readonly StoredTurn[];
  evidence: readonly StoredObserverEvidence[];
  events: readonly StoredEvent[];
}) {
  const [expandedTurnId, setExpandedTurnId] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'waiting' | 'blocked' | 'failed' | 'completed' | 'interrupted'
  >('all');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTurns = turns.filter((turn) => {
    if (statusFilter === 'active' && !['queued', 'running'].includes(turn.status)) return false;
    if (statusFilter !== 'all' && statusFilter !== 'active' && turn.status !== statusFilter) {
      return false;
    }
    if (normalizedQuery === '') return true;
    const turnEvidence = evidence.filter((item) => evidenceBelongsToTurn(item, turn));
    const evidenceText = turnEvidence
      .map((item) => `${item.reason} ${evidencePayloadSummary(item.payload) ?? ''}`)
      .join(' ');
    const eventText = events
      .filter((item) => eventBelongsToTurn(item, turn.id))
      .map(({ event }) => `${event.type} ${eventDetail(event) ?? ''}`)
      .join(' ');
    const searchable = [
      turn.title,
      turn.prompt,
      turn.status,
      turn.state.currentActivity?.label,
      evidenceText,
      eventText,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' ')
      .toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  });
  const hasTurnFilter = statusFilter !== 'all' || normalizedQuery !== '';

  return (
    <div className="evidence-card">
      <span className="eyebrow">TURNS</span>
      <div className="turn-heading">
        <strong>
          {hasTurnFilter ? `${visibleTurns.length} / ${turns.length}` : turns.length} task
          {turns.length === 1 ? '' : 's'}
        </strong>
        <div className="turn-toolbar">
          <label>
            <span className="sr-only">Search turns and evidence</span>
            <input
              className="timeline-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search turns"
              type="search"
            />
          </label>
          <label className="filter-label">
            <span className="sr-only">Filter turns by status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(
                  event.target.value as
                    | 'all'
                    | 'active'
                    | 'waiting'
                    | 'blocked'
                    | 'failed'
                    | 'completed'
                    | 'interrupted',
                )
              }
            >
              <option value="all">All turns</option>
              <option value="active">Active</option>
              <option value="waiting">Waiting</option>
              <option value="blocked">Blocked</option>
              <option value="failed">Failed</option>
              <option value="completed">Completed</option>
              <option value="interrupted">Interrupted</option>
            </select>
          </label>
        </div>
      </div>
      {visibleTurns.length === 0 ? (
        <small>
          {turns.length === 0
            ? 'No turn projection recorded yet.'
            : 'No turns match this search or status filter.'}
        </small>
      ) : (
        <ol className="turn-list">
          {visibleTurns.map((turn) => (
            <TurnListItem
              key={turn.id}
              turn={turn}
              evidence={evidence.filter((item) => evidenceBelongsToTurn(item, turn))}
              events={events.filter((item) => eventBelongsToTurn(item, turn.id))}
              expanded={expandedTurnId === turn.id}
              onToggle={() =>
                setExpandedTurnId((current) => (current === turn.id ? undefined : turn.id))
              }
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function TurnListItem({
  turn,
  evidence,
  events,
  expanded,
  onToggle,
}: {
  turn: StoredTurn;
  evidence: readonly StoredObserverEvidence[];
  events: readonly StoredEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li id={`turn-${turn.id}`}>
      <button className="turn-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
        <span className="timeline-seq">{turn.sequence}</span>
        <span className="turn-summary-copy">
          <strong>{turn.title ?? 'Untitled task'}</strong>
          <small>
            {statusLabel(turn.status)} · {formatDuration(turn.submittedAt, turn.endedAt)} ·{' '}
            {evidence.length} evidence
          </small>
        </span>
      </button>
      {expanded && (
        <>
          <TurnProjectionDetails turn={turn} />
          <TurnEvidenceDetails evidence={evidence} />
          <TurnTimelineDetails events={events} />
        </>
      )}
    </li>
  );
}

function TurnProjectionDetails({ turn }: { turn: StoredTurn }) {
  const { state } = turn;
  const eta = state.eta;

  return (
    <div className="turn-projection" aria-label="Turn progress and verification">
      <div className="turn-projection-heading">
        <span className="eyebrow">TURN PROJECTION</span>
        <span className={`status-pill status-pill-${state.status}`}>
          {statusLabel(state.status)}
        </span>
      </div>
      <div className="signal-grid">
        <Signal
          label="Progress"
          value={`${Math.round(state.progress.value * 100)}%`}
          confidence={state.progress.confidence}
          detail={state.progress.reasons[0]?.message ?? 'No turn progress reason.'}
        />
        <Signal
          label="ETA"
          value={eta === undefined ? 'Unavailable' : formatEta(eta.minSeconds, eta.maxSeconds)}
          confidence={eta?.confidence ?? 0}
          detail={eta?.reasons[0]?.message ?? 'No turn ETA signal has been observed.'}
        />
      </div>
      <div className="turn-projection-facts">
        <span>
          <b>Activity</b>
          {state.currentActivity?.label ?? 'No activity signal'}
        </span>
        <span>
          <b>Verification</b>
          {statusLabel(state.verification.overall)}
        </span>
      </div>
      <div className="verification-row">
        <Verification label="Tests" value={state.verification.tests} />
        <Verification label="Build" value={state.verification.build} />
        <Verification label="Typecheck" value={state.verification.typecheck} />
      </div>
      {state.telemetry !== undefined && <ProviderTelemetryDetails telemetry={state.telemetry} />}
    </div>
  );
}

function TurnTimelineDetails({ events }: { events: readonly StoredEvent[] }) {
  return (
    <div className="turn-timeline" aria-label="Turn timeline">
      <span className="eyebrow">TURN TIMELINE</span>
      {events.length === 0 ? (
        <small>No turn timeline events recorded yet.</small>
      ) : (
        <ol className="turn-timeline-list">
          {events.map(({ seq, event }) => (
            <li key={event.id}>
              <span className="timeline-seq">{seq}</span>
              <div>
                <strong>{statusLabel(event.type)}</strong>
                <small>
                  {formatTimestamp(event.timestamp)} · confidence{' '}
                  {Math.round(event.confidence * 100)}%
                </small>
                {eventDetail(event) !== undefined && <small>{eventDetail(event)}</small>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TurnEvidenceDetails({ evidence }: { evidence: readonly StoredObserverEvidence[] }) {
  return (
    <div className="turn-evidence" aria-label="Turn evidence details">
      {evidence.length === 0 ? (
        <small>No evidence is attached to this turn yet.</small>
      ) : (
        <ol className="turn-evidence-list">
          {evidence.map((item) => {
            const payloadSummary = evidencePayloadSummary(item.payload);
            return (
              <li key={item.id}>
                <div className="turn-evidence-heading">
                  <strong>{item.reason}</strong>
                  <span>
                    {item.source} · {item.kind}
                  </span>
                </div>
                <small>
                  {formatTimestamp(item.timestamp)} · confidence {Math.round(item.confidence * 100)}
                  % · {item.key}
                </small>
                {payloadSummary !== undefined && (
                  <code className="turn-evidence-payload">{payloadSummary}</code>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function observerEvidenceSummary(evidence: readonly StoredObserverEvidence[]): string {
  if (evidence.length === 0) return 'No workspace or process observer evidence recorded.';
  const sources = [...new Set(evidence.map((item) => item.source))].join(', ');
  const latest = evidence.at(-1);
  return latest === undefined
    ? `Sources: ${sources}`
    : `Sources: ${sources}. Latest: ${latest.reason}`;
}

function eventBelongsToTurn(stored: StoredEvent, turnId: string): boolean {
  if (typeof stored.event.payload !== 'object' || stored.event.payload === null) return false;
  const payload = stored.event.payload as { readonly turnId?: unknown };
  return payload.turnId === turnId;
}

function AgentCard({
  session,
  events,
}: {
  session: StoredSession;
  events: readonly StoredEvent[];
}) {
  const latestEvent = events.at(-1)?.event;
  const source = latestEvent?.source;
  const progress = session.state.progress;
  const eta = session.state.eta;
  const capabilityEntries = Object.entries(session.capabilities).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <section className="agent-card" aria-label="Agent evidence card">
      <div className="agent-card-heading">
        <div>
          <p className="eyebrow">AGENT CARD</p>
          <h3>
            {session.provider} · {session.adapter}
          </h3>
        </div>
        <span className={`status-pill status-pill-${session.status}`}>
          {statusLabel(session.status)}
        </span>
      </div>
      <div className="agent-facts">
        <Fact label="Client" value={source?.client ?? 'Not reported'} />
        <Fact label="Environment" value={source?.environment ?? 'Not reported'} />
        <Fact label="Conversation" value={conversationLabel(session)} />
        <Fact label="Continuation" value={continuationLabel(session)} />
        <Fact
          label="Activity"
          value={session.state.currentActivity?.label ?? 'No activity signal'}
        />
        <Fact
          label="Last event"
          value={latestEvent === undefined ? 'Not reported' : statusLabel(latestEvent.type)}
        />
      </div>
      <div className="signal-grid">
        <Signal
          label="Progress"
          value={`${Math.round(progress.value * 100)}%`}
          confidence={progress.confidence}
          detail={progress.reasons[0]?.message ?? 'No progress reason.'}
        />
        <Signal
          label="ETA"
          value={eta === undefined ? 'Unavailable' : formatEta(eta.minSeconds, eta.maxSeconds)}
          confidence={eta?.confidence ?? 0}
          detail={eta?.reasons[0]?.message ?? 'No ETA signal has been observed.'}
        />
      </div>
      {session.state.telemetry !== undefined && (
        <ProviderTelemetryDetails telemetry={session.state.telemetry} />
      )}
      {session.state.milestones.length > 0 && (
        <MilestoneDetails milestones={session.state.milestones} />
      )}
      <div className="agent-card-footer">
        <span className="evidence-label">Evidence capabilities</span>
        <div className="capability-list">
          {capabilityEntries.length === 0 ? (
            <span className="capability capability-muted">No capability report</span>
          ) : (
            capabilityEntries.map(([name, available]) => (
              <span
                className={`capability ${available ? 'capability-available' : 'capability-muted'}`}
                key={name}
              >
                {friendlyCapability(name)} · {available ? 'available' : 'not reported'}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="verification-row">
        <Verification label="Tests" value={session.state.verification.tests} />
        <Verification label="Build" value={session.state.verification.build} />
        <Verification label="Typecheck" value={session.state.verification.typecheck} />
      </div>
    </section>
  );
}

function ConversationGroupDetails({
  session,
  sessions,
  onSelectSession,
}: {
  session: StoredSession;
  sessions: readonly StoredSession[];
  onSelectSession: (id: string) => void;
}) {
  const conversation = session.state.conversation;
  const continuation = session.state.continuation;
  if (conversation === undefined && continuation === undefined) return null;

  const linkedSessions =
    conversation === undefined
      ? []
      : sessions.filter((candidate) => candidate.state.conversation?.id === conversation.id);
  return (
    <div className="evidence-card" aria-label="Conversation execution group">
      <span className="eyebrow">CONVERSATION LINK</span>
      <strong>
        {conversation === undefined
          ? 'Continuation requested, but no safe conversation id was reported.'
          : `${linkedSessions.length} linked execution${linkedSessions.length === 1 ? '' : 's'}`}
      </strong>
      <small>
        {conversation === undefined
          ? 'AgentScope keeps this execution independent until the provider exposes an id or you supply an explicit --resume reference.'
          : `${conversation.source === 'provider-session' ? 'Provider session' : 'Explicit resume'} · ${shortConversationId(conversation.id)}`}
      </small>
      {linkedSessions.length > 1 && (
        <div className="session-list">
          {linkedSessions.map((linked) => (
            <button
              className={`session-row ${linked.id === session.id ? 'session-row-selected' : ''}`}
              type="button"
              key={linked.id}
              onClick={() => onSelectSession(linked.id)}
            >
              <span className={`status-dot status-${linked.status}`} />
              <span className="session-row-copy">
                <strong>
                  {linked.provider} · {linked.adapter}
                </strong>
                <small>
                  {formatTimestamp(linked.startedAt)} · {linked.id}
                </small>
              </span>
              <span className={`status-pill status-pill-${linked.status}`}>
                {statusLabel(linked.status)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderTelemetryDetails({ telemetry }: { telemetry: ProviderTelemetry }) {
  const usage = telemetry.usage;
  const eventSummary = Object.entries(telemetry.nativeEventCounts ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([name, count]) => `${name} ×${count}`)
    .join(' · ');
  return (
    <div className="telemetry-panel" aria-label="Provider telemetry">
      <span className="eyebrow">PROVIDER TELEMETRY</span>
      <div className="telemetry-facts">
        <TelemetryFact label="Model" value={telemetry.providerInfo?.model ?? 'Not reported'} />
        <TelemetryFact label="CLI" value={telemetry.providerInfo?.cliVersion ?? 'Not reported'} />
        <TelemetryFact
          label="Provider tools"
          value={formatCount(telemetry.providerInfo?.toolCount)}
        />
        <TelemetryFact label="Input tokens" value={formatCount(usage?.inputTokens)} />
        <TelemetryFact label="Output tokens" value={formatCount(usage?.outputTokens)} />
        <TelemetryFact label="Total tokens" value={formatCount(usage?.totalTokens)} />
        <TelemetryFact label="Cache read" value={formatCount(usage?.cacheReadInputTokens)} />
        <TelemetryFact label="Cache create" value={formatCount(usage?.cacheCreationInputTokens)} />
        <TelemetryFact label="Thinking tokens" value={formatCount(usage?.thinkingTokens)} />
        <TelemetryFact label="Reasoning tokens" value={formatCount(usage?.reasoningTokens)} />
        <TelemetryFact label="Provider turns" value={formatCount(usage?.turnCount)} />
        <TelemetryFact
          label="Permission denials"
          value={formatCount(usage?.permissionDenialCount)}
        />
        <TelemetryFact label="Total cost" value={formatCost(usage?.totalCostUsd)} />
        <TelemetryFact label="API duration" value={formatMilliseconds(usage?.durationApiMs)} />
        <TelemetryFact label="TTFT" value={formatMilliseconds(usage?.ttftMs)} />
        <TelemetryFact label="Stream TTFT" value={formatMilliseconds(usage?.ttftStreamMs)} />
        <TelemetryFact
          label="First content"
          value={formatMilliseconds(usage?.firstContentFrameMs)}
        />
        <TelemetryFact label="Tool calls" value={formatCount(telemetry.toolCallCount)} />
        <TelemetryFact
          label="Tools finished"
          value={formatCount(telemetry.toolCallFinishedCount)}
        />
        <TelemetryFact label="Tool errors" value={formatCount(telemetry.toolCallErrorCount)} />
      </div>
      <small className="telemetry-event-summary">
        Native events: {eventSummary === '' ? 'Not reported' : eventSummary}
      </small>
    </div>
  );
}

function MilestoneDetails({ milestones }: { milestones: StoredSession['state']['milestones'] }) {
  return (
    <div className="milestone-panel" aria-label="Milestone details">
      <span className="eyebrow">MILESTONES</span>
      <ul className="milestone-list">
        {milestones.map((milestone) => (
          <li key={milestone.id}>
            <span>{milestone.title}</span>
            <span className="milestone-status">{milestone.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TelemetryFact({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <b>{label}</b>
      {value}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <b>{label}</b>
      {value}
    </span>
  );
}

function Signal({
  label,
  value,
  confidence,
  detail,
}: {
  label: string;
  value: string;
  confidence: number;
  detail: string;
}) {
  return (
    <div className="signal-card">
      <div className="signal-card-heading">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div
        className="confidence-bar"
        aria-label={`${label} confidence ${Math.round(confidence * 100)} percent`}
      >
        <span style={{ width: `${Math.round(confidence * 100)}%` }} />
      </div>
      <small>
        {detail} · confidence {Math.round(confidence * 100)}%
      </small>
    </div>
  );
}

function Verification({ label, value }: { label: string; value: string }) {
  return (
    <span className={`verification verification-${value}`}>
      <b>{label}</b>
      {statusLabel(value)}
    </span>
  );
}

function formatEta(minSeconds: number, maxSeconds: number): string {
  return `${formatDuration(0, minSeconds * 1000)}–${formatDuration(0, maxSeconds * 1000)}`;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? 'Not reported' : value.toLocaleString();
}

function conversationLabel(session: StoredSession): string {
  const conversation = session.state.conversation;
  if (conversation === undefined) return 'Not linked';
  return `${conversation.source === 'provider-session' ? 'Provider' : 'Explicit resume'} · ${shortConversationId(conversation.id)}`;
}

function shortConversationId(identifier: string): string {
  return identifier.length > 28 ? `${identifier.slice(0, 12)}…${identifier.slice(-8)}` : identifier;
}

function continuationLabel(session: StoredSession): string {
  const continuation = session.state.continuation;
  if (continuation === undefined) return 'Not requested';
  if (continuation.mode === 'continue') {
    return session.state.conversation === undefined ? 'Continue · unlinked' : 'Continue · linked';
  }
  return continuation.reference === undefined
    ? 'Resume · reference not reported'
    : 'Resume · explicit';
}

function formatCost(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `$${value.toFixed(4)}`;
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `${Math.round(value)}ms`;
}

function eventDetail(event: StoredEvent['event']): string | undefined {
  if (event.type === 'provider_event') {
    const payload = event.payload as {
      providerEventType?: unknown;
      phase?: unknown;
      subtype?: unknown;
    };
    const nativeType =
      typeof payload.providerEventType === 'string' ? payload.providerEventType : '';
    const phase = typeof payload.phase === 'string' ? `/${payload.phase}` : '';
    const subtype = typeof payload.subtype === 'string' ? ` · ${payload.subtype}` : '';
    return `Native ${nativeType}${phase}${subtype}`;
  }
  if (event.type === 'observer_activity') {
    const payload = event.payload as {
      kind?: unknown;
      label?: unknown;
      evidenceSource?: unknown;
      evidenceKind?: unknown;
      summary?: unknown;
    };
    const label = typeof payload.label === 'string' ? payload.label : 'activity observed';
    const source = typeof payload.evidenceSource === 'string' ? payload.evidenceSource : 'observer';
    const kind = typeof payload.evidenceKind === 'string' ? payload.evidenceKind : 'signal';
    const summary = typeof payload.summary === 'string' ? ` · ${payload.summary}` : '';
    return `Observed ${source}/${kind}: ${label}${summary}`;
  }
  if (event.type === 'provider_info') {
    const payload = event.payload as { model?: unknown; cliVersion?: unknown };
    const model = typeof payload.model === 'string' ? payload.model : 'model unavailable';
    const version =
      typeof payload.cliVersion === 'string' ? payload.cliVersion : 'version unavailable';
    return `Provider ${model} · CLI ${version}`;
  }
  if (event.type === 'usage_updated') {
    const usage = (event.payload as { usage?: Record<string, unknown> }).usage ?? {};
    const fields: string[] = [];
    if (typeof usage.inputTokens === 'number') fields.push(`in ${formatCount(usage.inputTokens)}`);
    if (typeof usage.outputTokens === 'number')
      fields.push(`out ${formatCount(usage.outputTokens)}`);
    if (typeof usage.thinkingTokens === 'number') {
      fields.push(`thinking ${formatCount(usage.thinkingTokens)}`);
    }
    if (typeof usage.thinkingTokensDelta === 'number') {
      fields.push(`Δthinking ${formatCount(usage.thinkingTokensDelta)}`);
    }
    if (typeof usage.totalTokens === 'number') {
      fields.push(`total ${formatCount(usage.totalTokens)}`);
    }
    if (typeof usage.turnCount === 'number') {
      fields.push(`turns ${formatCount(usage.turnCount)}`);
    }
    if (typeof usage.permissionDenialCount === 'number') {
      fields.push(`denials ${formatCount(usage.permissionDenialCount)}`);
    }
    if (typeof usage.totalCostUsd === 'number') fields.push(formatCost(usage.totalCostUsd));
    if (typeof usage.durationApiMs === 'number')
      fields.push(`API ${formatMilliseconds(usage.durationApiMs)}`);
    if (typeof usage.ttftMs === 'number') fields.push(`TTFT ${formatMilliseconds(usage.ttftMs)}`);
    return fields.length === 0 ? 'Provider usage snapshot updated' : fields.join(' · ');
  }
  if (event.type === 'tool_call_started') {
    const toolName = (event.payload as { toolName?: unknown }).toolName;
    return typeof toolName === 'string' ? `Tool ${toolName} started` : 'Tool call started';
  }
  if (event.type === 'tool_call_finished') {
    const payload = event.payload as {
      toolName?: unknown;
      success?: unknown;
      durationMs?: unknown;
    };
    const tool = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
    const result = payload.success === true ? 'succeeded' : 'failed';
    const duration =
      typeof payload.durationMs === 'number' ? ` · ${formatMilliseconds(payload.durationMs)}` : '';
    return `Tool ${tool} ${result}${duration}`;
  }
  return undefined;
}

function friendlyCapability(name: string): string {
  return name
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}

function workspaceLabel(workspace: StoredSession['workspace']): string {
  const rootPath = workspace?.rootPath;
  return typeof rootPath === 'string' ? rootPath : 'Not reported';
}
