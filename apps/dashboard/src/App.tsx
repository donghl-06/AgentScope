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
    <li>
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
