import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  StoredEvent,
  StoredObserverEvidence,
  StoredSession,
  StoredTurn,
} from '@agentscope/storage';

import { DashboardApi, type DashboardLiveNotification } from './api.js';
import { formatDuration, formatTimestamp, statusLabel } from './format.js';
import { hasTimelineGap, lastTimelineSeq, mergeTimelineEvents } from './timeline.js';

const api = new DashboardApi();

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
  const selectedIdRef = useRef<string | undefined>(undefined);
  const lastSeqBySessionRef = useRef(new Map<string, number>());

  const refreshSessions = useCallback(async () => {
    try {
      const page = await api.listSessions({ limit: 100 });
      setSessions(page.items);
      setError(undefined);
      setSelectedId((current) => current ?? page.items[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string, after?: number) => {
    setDetailLoading(true);
    try {
      const [session, page, observerEvidence, sessionTurns] = await Promise.all([
        api.getSession(id),
        api.listEvents(id, after ?? 0),
        api.listObserverEvidence(id),
        api.listTurns(id),
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
            (message.type === 'turn.created' || message.type === 'turn.updated') &&
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
  }, [refreshDetail, refreshSessions]);

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
              events={events}
              turns={turns}
              evidence={evidence}
              eventsNextCursor={eventsNextCursor}
              loading={detailLoading}
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
  events,
  turns,
  evidence,
  eventsNextCursor,
  loading,
  onLoadMore,
}: {
  session: StoredSession;
  events: readonly StoredEvent[];
  turns: readonly StoredTurn[];
  evidence: readonly StoredObserverEvidence[];
  eventsNextCursor: string | undefined;
  loading: boolean;
  onLoadMore: () => void;
}) {
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
      <TurnList turns={turns} evidence={evidence} />
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
          <span>{loading ? 'Refreshing…' : `${events.length} events`}</span>
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
      {events.length === 0 ? (
        <p className="empty-state">No events recorded.</p>
      ) : (
        <ol className="timeline">
          {events.map(({ seq, event }) => (
            <li key={event.id}>
              <span className="timeline-seq">{seq}</span>
              <div>
                <strong>{statusLabel(event.type)}</strong>
                <small>
                  {formatTimestamp(event.timestamp)} · confidence{' '}
                  {Math.round(event.confidence * 100)}%
                </small>
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
}: {
  turns: readonly StoredTurn[];
  evidence: readonly StoredObserverEvidence[];
}) {
  const [expandedTurnId, setExpandedTurnId] = useState<string>();

  return (
    <div className="evidence-card">
      <span className="eyebrow">TURNS</span>
      <strong>
        {turns.length} task{turns.length === 1 ? '' : 's'}
      </strong>
      {turns.length === 0 ? (
        <small>No turn projection recorded yet.</small>
      ) : (
        <ol className="turn-list">
          {turns.map((turn) => (
            <TurnListItem
              key={turn.id}
              turn={turn}
              evidence={evidence.filter((item) => evidenceBelongsToTurn(item, turn.id))}
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
  expanded,
  onToggle,
}: {
  turn: StoredTurn;
  evidence: readonly StoredObserverEvidence[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        className="turn-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="timeline-seq">{turn.sequence}</span>
        <span className="turn-summary-copy">
          <strong>{turn.title ?? 'Untitled task'}</strong>
          <small>
            {statusLabel(turn.status)} · {formatDuration(turn.submittedAt, turn.endedAt)} ·{' '}
            {evidence.length} evidence
          </small>
        </span>
      </button>
      {expanded && <TurnEvidenceDetails evidence={evidence} />}
    </li>
  );
}

function TurnEvidenceDetails({
  evidence,
}: {
  evidence: readonly StoredObserverEvidence[];
}) {
  return (
    <div className="turn-evidence" aria-label="Turn evidence details">
      {evidence.length === 0 ? (
        <small>No evidence is attached to this turn yet.</small>
      ) : (
        <ol className="turn-evidence-list">
          {evidence.map((item) => (
            <li key={item.id}>
              <div className="turn-evidence-heading">
                <strong>{item.reason}</strong>
                <span>
                  {item.source} · {item.kind}
                </span>
              </div>
              <small>
                {formatTimestamp(item.timestamp)} · confidence{' '}
                {Math.round(item.confidence * 100)}% · {item.key}
              </small>
            </li>
          ))}
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

function evidenceBelongsToTurn(evidence: StoredObserverEvidence, turnId: string): boolean {
  if (evidence.turnId === turnId) return true;
  if (typeof evidence.payload !== 'object' || evidence.payload === null) return false;
  const payload = evidence.payload as { readonly turnId?: unknown };
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

function friendlyCapability(name: string): string {
  return name
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}

function workspaceLabel(workspace: StoredSession['workspace']): string {
  const rootPath = workspace?.rootPath;
  return typeof rootPath === 'string' ? rootPath : 'Not reported';
}
