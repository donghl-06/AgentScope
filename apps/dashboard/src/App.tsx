import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredEvent, StoredSession } from '@agentscope/storage';

import { DashboardApi, type DashboardLiveNotification } from './api.js';
import { formatDuration, formatTimestamp, statusLabel } from './format.js';

const api = new DashboardApi();

export function App() {
  const [sessions, setSessions] = useState<readonly StoredSession[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<StoredSession>();
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'offline'>(
    'connecting',
  );
  const selectedIdRef = useRef<string | undefined>(undefined);

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

  const refreshDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const [session, page] = await Promise.all([api.getSession(id), api.listEvents(id)]);
      setSelected(session);
      setEvents(page.items);
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
    void refreshSessions();
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
              void refreshDetail(message.sessionId);
            }
          }
        });
        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          setConnectionState('connected');
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

    connect();
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
            <button
              className="quiet-button"
              type="button"
              onClick={() => void refreshSessions()}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <p className="empty-state">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="empty-state">No sessions recorded yet.</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
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
            <SessionDetail session={selected} events={events} loading={detailLoading} />
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
  loading,
}: {
  session: StoredSession;
  events: readonly StoredEvent[];
  loading: boolean;
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
      <div className="evidence-card">
        <span className="eyebrow">ACTIVITY</span>
        <strong>{session.state.currentActivity?.label ?? 'No activity signal'}</strong>
        <small>
          {session.state.progress.reasons[0]?.message ?? 'No progress explanation available.'}
        </small>
      </div>
      <div className="timeline-heading">
        <h3>Timeline</h3>
        <span>{loading ? 'Refreshing…' : `${events.length} events`}</span>
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

function workspaceLabel(workspace: StoredSession['workspace']): string {
  const rootPath = workspace?.rootPath;
  return typeof rootPath === 'string' ? rootPath : 'Not reported';
}
