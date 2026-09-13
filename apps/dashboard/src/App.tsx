import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  StoredGoal,
  StoredGoalInstruction,
  StoredEvent,
  StoredObserverEvidence,
  StoredOrchestratorNotification,
  StoredSession,
  StoredTask,
  StoredTurn,
} from '@agentscope/storage';
import type { ProviderTelemetry } from '@agentscope/protocol';

import {
  DashboardApi,
  DashboardApiError,
  type CreateGoalRequest,
  type DashboardLiveNotification,
  type GoalDetail,
  type SessionDetail as DashboardSessionDetail,
} from './api.js';
import { evidenceBelongsToTurn, evidencePayloadSummary } from './evidence.js';
import { formatDuration, formatTimestamp, statusLabel } from './format.js';
import { loadAllPages } from './pagination.js';
import { hasTimelineGap, lastTimelineSeq, mergeTimelineEvents } from './timeline.js';

const api = new DashboardApi();
type NotificationState = NotificationPermission | 'unsupported' | 'requesting' | 'unavailable';
type OrchestratorNotificationMode = 'all' | 'attention' | 'muted';
const NOTIFIABLE_SESSION_STATUSES = new Set(['blocked', 'completed', 'failed', 'interrupted']);
const ORCHESTRATOR_NOTIFICATION_PREFERENCE_KEY = 'agentscope.orchestrator-notifications';

export function App() {
  const [sessions, setSessions] = useState<readonly StoredSession[]>([]);
  const [goals, setGoals] = useState<readonly StoredGoal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [goalActionBusy, setGoalActionBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    loadSelectionFromUrl('session'),
  );
  const [selected, setSelected] = useState<DashboardSessionDetail>();
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [turns, setTurns] = useState<readonly StoredTurn[]>([]);
  const [evidence, setEvidence] = useState<readonly StoredObserverEvidence[]>([]);
  const [eventsNextCursor, setEventsNextCursor] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<'all' | StoredSession['status']>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [sessionActionId, setSessionActionId] = useState<string>();
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
  const [orchestratorNotificationMode, setOrchestratorNotificationMode] =
    useState<OrchestratorNotificationMode>(() => loadOrchestratorNotificationMode());
  const selectedIdRef = useRef<string | undefined>(undefined);
  const lastSeqBySessionRef = useRef(new Map<string, number>());
  const notificationStateRef = useRef(notificationState);
  const notificationRequestRef = useRef(0);
  const notificationKeysRef = useRef(new Set<string>());
  const notificationBaselineReadyRef = useRef(false);
  const orchestratorNotificationBaselineReadyRef = useRef(false);
  const orchestratorNotificationModeRef = useRef(orchestratorNotificationMode);

  useEffect(() => {
    notificationStateRef.current = notificationState;
  }, [notificationState]);

  useEffect(() => {
    orchestratorNotificationModeRef.current = orchestratorNotificationMode;
    try {
      globalThis.localStorage?.setItem(
        ORCHESTRATOR_NOTIFICATION_PREFERENCE_KEY,
        orchestratorNotificationMode,
      );
    } catch {
      // Browser storage may be unavailable in private or restricted contexts.
    }
  }, [orchestratorNotificationMode]);

  const refreshSessions = useCallback(async () => {
    try {
      const page = await api.listSessions({
        limit: 100,
        ...(showHidden ? { includeHidden: true } : {}),
      });
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
  }, [showHidden]);

  const refreshGoals = useCallback(async () => {
    try {
      const nextGoals = await api.listGoals();
      setGoals(nextGoals);
      if (!orchestratorNotificationBaselineReadyRef.current) {
        orchestratorNotificationBaselineReadyRef.current = true;
        const baseline = await Promise.allSettled(
          nextGoals.map((goal) => api.listGoalNotifications(goal.id, 100)),
        );
        for (const result of baseline) {
          if (result.status !== 'fulfilled') continue;
          for (const notification of result.value) {
            notificationKeysRef.current.add(`goal-notification:${notification.id}`);
          }
        }
      }
    } catch (cause) {
      // Keep the Monitor V0 dashboard usable against an older server that has
      // not enabled the Orchestrator API yet.
      if (!(cause instanceof DashboardApiError && cause.status === 503)) {
        setError(cause instanceof Error ? cause.message : 'Unable to load orchestrator goals.');
      }
    } finally {
      setGoalsLoading(false);
    }
  }, []);

  const submitGoal = useCallback(
    async (input: CreateGoalRequest) => {
      setGoalActionBusy(true);
      try {
        await api.createGoal(input);
        await refreshGoals();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to start orchestrator goal.');
      } finally {
        setGoalActionBusy(false);
      }
    },
    [refreshGoals],
  );

  const changeSessionVisibility = useCallback(
    async (session: StoredSession, hidden: boolean) => {
      if (session.status === 'starting' || session.status === 'running') return;
      const action = hidden ? 'hide' : 'restore';
      if (
        typeof globalThis.confirm === 'function' &&
        !globalThis.confirm(
          hidden
            ? `Hide this ${session.provider} session from the default list?`
            : `Restore this ${session.provider} session to the default list?`,
        )
      ) {
        return;
      }
      setSessionActionId(session.id);
      try {
        if (hidden) await api.hideSession(session.id);
        else await api.unhideSession(session.id);
        await refreshSessions();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Unable to ${action} session.`);
      } finally {
        setSessionActionId(undefined);
      }
    },
    [refreshSessions],
  );

  const permanentlyDeleteSession = useCallback(
    async (session: StoredSession) => {
      if (session.status === 'starting' || session.status === 'running') return;
      if (
        typeof globalThis.confirm === 'function' &&
        !globalThis.confirm(
          `Permanently delete this ${session.provider} session and its AgentScope evidence? This cannot be undone.`,
        )
      ) {
        return;
      }
      setSessionActionId(session.id);
      try {
        await api.deleteSession(session.id);
        if (selectedIdRef.current === session.id) {
          setSelectedId(undefined);
          setSelected(undefined);
          setEvents([]);
          setTurns([]);
          setEvidence([]);
          setEventsNextCursor(undefined);
          lastSeqBySessionRef.current.delete(session.id);
        }
        await refreshSessions();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to delete session.');
      } finally {
        setSessionActionId(undefined);
      }
    },
    [refreshSessions],
  );

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
    if (
      message.type === 'goal.notification.created' ||
      message.type === 'goal.notification.updated'
    ) {
      const mode = orchestratorNotificationModeRef.current;
      if (mode === 'muted') return;
      const kind = message.payload?.kind;
      if (mode === 'attention' && kind !== 'failed' && kind !== 'needs-human') return;
      if (
        notificationStateRef.current !== 'granted' ||
        typeof globalThis.Notification === 'undefined'
      ) {
        return;
      }
      const notificationId = message.payload?.notificationId;
      const id = typeof notificationId === 'string' ? notificationId : 'unknown-notification';
      const key = `goal-notification:${id}`;
      if (notificationKeysRef.current.has(key)) return;
      notificationKeysRef.current.add(key);
      const goalId = message.goalId ?? 'unknown-goal';
      const label = typeof kind === 'string' ? kind.replaceAll('-', ' ') : 'attention required';
      try {
        new globalThis.Notification(`AgentScope · Goal ${label}`, {
          body: `Goal ${goalId.slice(0, 8)} has a new actionable status.`,
          tag: key,
        });
      } catch {
        // Browser notification failures must never affect live monitoring.
      }
      return;
    }
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
    syncSelectionToUrl('session', selectedId);
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
          if (isOrchestratorNotification(message)) void refreshGoals();
          if (message.type === 'session.deleted' && message.sessionId !== undefined) {
            const deletedId = message.sessionId;
            setSessions((current) => current.filter((session) => session.id !== deletedId));
            if (selectedIdRef.current === deletedId) {
              setSelectedId(undefined);
              setSelected(undefined);
              setEvents([]);
              setTurns([]);
              setEvidence([]);
              setEventsNextCursor(undefined);
              lastSeqBySessionRef.current.delete(deletedId);
            }
            return;
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

    void Promise.allSettled([refreshSessions(), refreshGoals()]).finally(() => {
      if (!stopped) connect();
    });
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [notifyLiveStatus, refreshDetail, refreshGoals, refreshSessions]);

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
        <NotificationControl
          state={notificationState}
          mode={orchestratorNotificationMode}
          onEnable={enableNotifications}
          onModeChange={setOrchestratorNotificationMode}
        />
      </header>

      {error !== undefined && <div className="banner banner-error">{error}</div>}

      <section className="stat-grid" aria-label="Session summary">
        <Stat label="Active" value={counts.active} tone="blue" />
        <Stat label="Blocked" value={counts.blocked} tone="amber" />
        <Stat label="Completed" value={counts.completed} tone="green" />
        <Stat label="Failed" value={counts.failed} tone="red" />
      </section>

      <GoalPanel
        goals={goals}
        loading={goalsLoading}
        actionBusy={goalActionBusy}
        onRefresh={() => void refreshGoals()}
        onCreate={submitGoal}
        onSelectSession={setSelectedId}
      />

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
              <label className="visibility-toggle">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />{' '}
                Show hidden
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
                  actionBusy={sessionActionId === session.id}
                  onHide={() => void changeSessionVisibility(session, true)}
                  onUnhide={() => void changeSessionVisibility(session, false)}
                  onDelete={() => void permanentlyDeleteSession(session)}
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

function GoalPanel({
  goals,
  loading,
  actionBusy,
  onRefresh,
  onCreate,
  onSelectSession,
}: {
  goals: readonly StoredGoal[];
  loading: boolean;
  actionBusy: boolean;
  onRefresh: () => void;
  onCreate: (input: CreateGoalRequest) => Promise<void>;
  onSelectSession: (sessionId: string) => void;
}) {
  type GoalStatusFilter = 'all' | StoredGoal['status'];
  type GoalHistoryFilter = {
    status: GoalStatusFilter;
    provider: string;
    workspace: string;
    query: string;
    includeArchived: boolean;
  };
  const [workspace, setWorkspace] = useState('.');
  const [provider, setProvider] = useState<'claude' | 'codex' | 'codex-app-server'>('claude');
  const [prompt, setPrompt] = useState('');
  const [selectedGoalId, setSelectedGoalId] = useState<string | undefined>(() =>
    loadSelectionFromUrl('goal'),
  );
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(() =>
    loadSelectionFromUrl('task'),
  );
  const [focusedAttemptId, setFocusedAttemptId] = useState<string | undefined>(() =>
    loadSelectionFromUrl('attempt'),
  );
  const [selectedGoal, setSelectedGoal] = useState<GoalDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [goalError, setGoalError] = useState<string>();
  const [historyFilter, setHistoryFilter] = useState<GoalHistoryFilter>(() =>
    loadGoalHistoryFilter(),
  );
  const [historyGoals, setHistoryGoals] = useState<readonly StoredGoal[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const historyRequestRef = useRef(0);

  const loadGoalHistory = useCallback(
    async (cursor?: string) => {
      const requestId = ++historyRequestRef.current;
      if (cursor === undefined) setHistoryLoading(true);
      else setHistoryLoadingMore(true);
      try {
        const page = await api.listGoalPage({
          limit: 50,
          ...(historyFilter.status === 'all' ? {} : { status: historyFilter.status }),
          ...(historyFilter.provider.trim() === ''
            ? {}
            : { provider: historyFilter.provider.trim() }),
          ...(historyFilter.workspace.trim() === ''
            ? {}
            : { workspace: historyFilter.workspace.trim() }),
          ...(historyFilter.query.trim() === '' ? {} : { query: historyFilter.query.trim() }),
          ...(historyFilter.includeArchived ? { includeArchived: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (requestId !== historyRequestRef.current) return;
        setHistoryGoals((current) =>
          cursor === undefined ? page.items : mergeGoals(current, page.items),
        );
        setHistoryCursor(page.nextCursor);
      } catch (cause) {
        if (requestId !== historyRequestRef.current) return;
        setGoalError(cause instanceof Error ? cause.message : 'Unable to load Goal history.');
        if (cursor === undefined) {
          setHistoryGoals([]);
          setHistoryCursor(undefined);
        }
      } finally {
        if (requestId === historyRequestRef.current) {
          if (cursor === undefined) setHistoryLoading(false);
          else setHistoryLoadingMore(false);
        }
      }
    },
    [historyFilter],
  );

  useEffect(() => {
    void loadGoalHistory();
  }, [goals, loadGoalHistory]);

  useEffect(() => {
    syncGoalHistoryFilter(historyFilter);
  }, [historyFilter]);

  const updateHistoryFilter = <K extends keyof GoalHistoryFilter>(
    key: K,
    value: GoalHistoryFilter[K],
  ) => {
    setHistoryFilter((current) => ({ ...current, [key]: value }));
  };

  const refreshAllGoals = () => {
    onRefresh();
    void loadGoalHistory();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (prompt.trim().length === 0 || workspace.trim().length === 0) return;
    void onCreate({ workspace: workspace.trim(), prompt: prompt.trim(), provider });
    setPrompt('');
  };

  const inspectGoal = useCallback(async (goalId: string) => {
    setSelectedGoalId(goalId);
    setDetailLoading(true);
    try {
      setSelectedGoal(await api.getGoal(goalId));
      setGoalError(undefined);
    } catch (cause) {
      setGoalError(cause instanceof Error ? cause.message : 'Unable to load Goal details.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    syncSelectionToUrl('goal', selectedGoalId);
  }, [selectedGoalId]);

  useEffect(() => {
    syncSelectionToUrl('task', focusedTaskId);
  }, [focusedTaskId]);

  useEffect(() => {
    syncSelectionToUrl('attempt', focusedAttemptId);
  }, [focusedAttemptId]);

  useEffect(() => {
    if (selectedGoalId !== undefined && selectedGoal === undefined) {
      void inspectGoal(selectedGoalId);
    }
  }, [inspectGoal, selectedGoal, selectedGoalId]);

  const controlGoal = async (action: 'pause' | 'abort' | 'continue') => {
    if (selectedGoalId === undefined) return;
    setDetailLoading(true);
    try {
      if (action === 'pause') await api.pauseGoal(selectedGoalId);
      else if (action === 'abort') await api.abortGoal(selectedGoalId);
      else await api.continueGoal(selectedGoalId);
      await onRefresh();
      await inspectGoal(selectedGoalId);
    } catch (cause) {
      setGoalError(cause instanceof Error ? cause.message : 'Unable to control Goal.');
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <section className="panel goals-panel" aria-label="Orchestrator goals">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ORCHESTRATOR</p>
          <h2>Goals and evidence-gated work</h2>
        </div>
        <button
          className="quiet-button quiet-button-small"
          type="button"
          onClick={refreshAllGoals}
          disabled={historyLoading}
        >
          Refresh
        </button>
      </div>
      <form className="goal-form" onSubmit={submit}>
        <label>
          <span>Workspace</span>
          <input
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="Workspace path"
            required
          />
        </label>
        <label>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as 'claude' | 'codex' | 'codex-app-server')
            }
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex CLI</option>
            <option value="codex-app-server">Codex app-server</option>
          </select>
        </label>
        <label className="goal-form-prompt">
          <span>Goal</span>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the larger coding goal"
            required
          />
        </label>
        <button className="quiet-button" type="submit" disabled={actionBusy}>
          {actionBusy ? 'Starting…' : 'Start goal'}
        </button>
      </form>
      <NotificationCenter goals={goals} onSelectGoal={(goalId) => void inspectGoal(goalId)} />
      <div className="goal-history-toolbar" aria-label="Goal history filters">
        <label className="goal-history-search">
          <span>Search</span>
          <input
            value={historyFilter.query}
            onChange={(event) => updateHistoryFilter('query', event.target.value)}
            placeholder="Goal ID or prompt"
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={historyFilter.status}
            onChange={(event) =>
              updateHistoryFilter('status', event.target.value as 'all' | StoredGoal['status'])
            }
          >
            <option value="all">All statuses</option>
            <option value="CREATED">Created</option>
            <option value="PLANNING">Planning</option>
            <option value="RUNNING">Running</option>
            <option value="VERIFYING">Verifying</option>
            <option value="PAUSED">Paused</option>
            <option value="NEEDS_HUMAN">Needs human</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="ABORTED">Aborted</option>
          </select>
        </label>
        <label>
          <span>Provider</span>
          <input
            value={historyFilter.provider}
            onChange={(event) => updateHistoryFilter('provider', event.target.value)}
            placeholder="Any provider"
          />
        </label>
        <label className="goal-history-workspace">
          <span>Workspace</span>
          <input
            value={historyFilter.workspace}
            onChange={(event) => updateHistoryFilter('workspace', event.target.value)}
            placeholder="Any workspace"
          />
        </label>
        <label className="visibility-toggle">
          <input
            type="checkbox"
            checked={historyFilter.includeArchived}
            onChange={(event) => updateHistoryFilter('includeArchived', event.target.checked)}
          />{' '}
          Include archived
        </label>
      </div>
      {historyLoading || (loading && historyGoals.length === 0) ? (
        <p className="empty-state">Loading goals…</p>
      ) : historyGoals.length === 0 ? (
        <p className="empty-state">
          {historyFilter.includeArchived
            ? 'No Goals match these history filters.'
            : 'No active or historical Goals recorded yet.'}
        </p>
      ) : (
        <GoalHistoryList
          goals={historyGoals}
          selectedGoalId={selectedGoalId}
          onSelectGoal={(goalId) => void inspectGoal(goalId)}
        />
      )}
      {historyCursor !== undefined && (
        <button
          className="quiet-button quiet-button-small goal-history-load-more"
          type="button"
          onClick={() => void loadGoalHistory(historyCursor)}
          disabled={historyLoadingMore}
        >
          {historyLoadingMore ? 'Loading…' : 'Load more Goals'}
        </button>
      )}
      {goalError !== undefined && <p className="goal-error">{goalError}</p>}
      {selectedGoalId !== undefined && (
        <div className="goal-detail">
          {detailLoading && selectedGoal === undefined ? (
            <p className="empty-state">Loading Goal details…</p>
          ) : selectedGoal === undefined ? null : (
            <>
              <div className="goal-detail-heading">
                <div>
                  <span className="eyebrow">GOAL DETAIL</span>
                  <strong>{statusLabel(selectedGoal.goal.status)}</strong>
                </div>
                <div className="goal-detail-actions">
                  {['CREATED', 'PLANNING', 'RUNNING', 'VERIFYING'].includes(
                    selectedGoal.goal.status,
                  ) && (
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => void controlGoal('pause')}
                      disabled={detailLoading}
                    >
                      Pause
                    </button>
                  )}
                  {selectedGoal.goal.status === 'PAUSED' && (
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => void controlGoal('continue')}
                      disabled={detailLoading}
                    >
                      Continue
                    </button>
                  )}
                  {!['COMPLETED', 'FAILED', 'ABORTED'].includes(selectedGoal.goal.status) && (
                    <button
                      className="quiet-button quiet-button-small quiet-button-danger"
                      type="button"
                      onClick={() => void controlGoal('abort')}
                      disabled={detailLoading}
                    >
                      Abort
                    </button>
                  )}
                </div>
              </div>
              <div className="goal-detail-grid">
                <span>
                  <b>Tasks</b>
                  {selectedGoal.tasks.length}
                </span>
                <span>
                  <b>Events</b>
                  {selectedGoal.events.length}
                </span>
                <span>
                  <b>Attempts</b>
                  {selectedGoal.taskDetails?.reduce(
                    (total, item) => total + item.attempts.length,
                    0,
                  ) ?? 0}
                </span>
              </div>
              <GoalInstructionPanel
                detail={selectedGoal}
                onRefresh={onRefresh}
                onReload={() => inspectGoal(selectedGoal.goal.id)}
              />
              <RoadmapEditor
                detail={selectedGoal}
                onRefresh={onRefresh}
                onReload={() => inspectGoal(selectedGoal.goal.id)}
              />
              <ol className="goal-task-list">
                {selectedGoal.tasks.map((task) => {
                  const taskDetail = selectedGoal.taskDetails?.find(
                    (item) => item.task.id === task.id,
                  );
                  const focused = focusedTaskId === task.id;
                  return (
                    <li key={task.id} className={focused ? 'goal-task-focused' : undefined}>
                      <button
                        className="goal-task-select"
                        type="button"
                        onClick={() => setFocusedTaskId(focused ? undefined : task.id)}
                        aria-expanded={focused}
                      >
                        <span>{task.sequence}</span>
                        <span>
                          <strong>{task.title}</strong>
                          <small>
                            {statusLabel(task.status)} · {taskDetail?.attempts.length ?? 0}{' '}
                            attempt(s) · verification{' '}
                            {statusLabel(taskDetail?.verifications.at(-1)?.status ?? 'UNKNOWN')}
                          </small>
                        </span>
                      </button>
                      {focused && taskDetail !== undefined && (
                        <div className="goal-task-detail">
                          {taskDetail.attempts.length === 0 ? (
                            <small>No attempts recorded.</small>
                          ) : (
                            taskDetail.attempts.map((attempt) => (
                              <div className="goal-attempt-row" key={attempt.id}>
                                <div>
                                  <strong>Attempt {attempt.attemptNumber}</strong>
                                  <small>
                                    {statusLabel(attempt.status)} · {shortId(attempt.id)}
                                  </small>
                                </div>
                                {attempt.sessionId === undefined ? (
                                  <span className="goal-reference-missing">
                                    Session unavailable
                                  </span>
                                ) : (
                                  <button
                                    className="quiet-button quiet-button-small"
                                    type="button"
                                    onClick={() => {
                                      setFocusedAttemptId(attempt.id);
                                      onSelectSession(attempt.sessionId!);
                                    }}
                                  >
                                    Open Session
                                  </button>
                                )}
                              </div>
                            ))
                          )}
                          {taskDetail.verifications.length === 0 ? (
                            <small>No verification runs recorded.</small>
                          ) : (
                            <div className="goal-verification-list">
                              <span className="eyebrow">VERIFICATION</span>
                              {taskDetail.verifications.map((verification) => (
                                <div className="goal-verification-row" key={verification.id}>
                                  <strong>{statusLabel(verification.status)}</strong>
                                  <small>
                                    {shortId(verification.id)} · {verification.reason}
                                  </small>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="goal-event-list" aria-label="Goal event timeline">
                <span className="eyebrow">EVENT TIMELINE</span>
                {selectedGoal.events.length === 0 ? (
                  <p className="empty-state">No orchestrator events recorded yet.</p>
                ) : (
                  selectedGoal.events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <div className="goal-event-row" key={event.id}>
                        <strong>{event.type}</strong>
                        <small>
                          {formatTimestamp(event.timestamp)} · confidence{' '}
                          {Math.round(event.confidence * 100)}%
                        </small>
                      </div>
                    ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function GoalInstructionPanel({
  detail,
  onRefresh,
  onReload,
}: {
  detail: GoalDetail;
  onRefresh: () => void;
  onReload: () => Promise<void>;
}) {
  const [kind, setKind] = useState<StoredGoalInstruction['kind']>('general');
  const [content, setContent] = useState('');
  const [baseRevision, setBaseRevision] = useState(String(detail.goal.activeRevision));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const isTerminal = ['COMPLETED', 'FAILED', 'ABORTED'].includes(detail.goal.status);
  const instructions = (detail.instructions ?? [])
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));

  useEffect(() => {
    setBaseRevision(String(detail.goal.activeRevision));
    setError(undefined);
    setSuccess(undefined);
  }, [detail.goal.id, detail.goal.activeRevision]);

  const submitInstruction = async (continueAfter: boolean) => {
    if (submitting || isTerminal) return;
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      setError('Instruction content must not be empty.');
      setSuccess(undefined);
      return;
    }
    const parsedRevision = Number(baseRevision.trim());
    if (!Number.isInteger(parsedRevision) || parsedRevision < 0) {
      setError('作用 revision 必须是非负整数。');
      setSuccess(undefined);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSuccess(undefined);
    let submitted = false;
    try {
      await api.submitGoalInstruction(detail.goal.id, {
        kind,
        content,
        baseRevision: parsedRevision,
        expectedRevision: detail.goal.activeRevision,
        idempotencyKey: createClientRequestId('instruction'),
      });
      submitted = true;
      if (continueAfter) await api.continueGoal(detail.goal.id);
      onRefresh();
      await onReload();
      setContent('');
      setSuccess(
        continueAfter
          ? 'Instruction submitted; Continue was requested safely.'
          : 'Instruction submitted and queued for the next safe boundary.',
      );
    } catch (cause) {
      setError(
        submitted
          ? `Instruction was saved, but Continue could not be requested: ${formatError(cause)}`
          : formatError(cause),
      );
      if (submitted) void onReload();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="goal-instruction-panel" aria-label="Human instructions">
      <div className="goal-instruction-heading">
        <div>
          <span className="eyebrow">HUMAN INSTRUCTION</span>
          <strong>Give Instruction</strong>
          <small>
            {isTerminal
              ? 'Terminal Goals cannot receive new instructions.'
              : 'Instructions are applied only at the next safe Task boundary.'}
          </small>
        </div>
        <span className="goal-instruction-revision">
          Active revision {detail.goal.activeRevision}
        </span>
      </div>
      <form
        className="goal-instruction-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submitInstruction(false);
        }}
      >
        <label>
          <span>Type</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as StoredGoalInstruction['kind'])}
            disabled={submitting || isTerminal}
          >
            <option value="general">General</option>
            <option value="clarification">Clarification</option>
            <option value="constraint">Constraint</option>
            <option value="priority">Priority</option>
            <option value="approval-context">Approval context</option>
          </select>
        </label>
        <label>
          <span>作用 revision</span>
          <input
            type="number"
            min="0"
            step="1"
            value={baseRevision}
            onChange={(event) => setBaseRevision(event.target.value)}
            disabled={submitting || isTerminal}
            aria-describedby="goal-instruction-revision-help"
          />
        </label>
        <label className="goal-instruction-content">
          <span>Instruction</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Describe a concrete change or constraint for the next safe boundary."
            rows={3}
            maxLength={16_000}
            disabled={submitting || isTerminal}
            aria-describedby="goal-instruction-revision-help"
          />
        </label>
        <small id="goal-instruction-revision-help" className="goal-instruction-help">
          Submitted against revision {detail.goal.activeRevision}; a mismatch is rejected instead of
          overwriting newer decisions.
        </small>
        <div className="goal-instruction-actions">
          <button
            className="quiet-button quiet-button-small"
            type="submit"
            disabled={submitting || isTerminal}
          >
            {submitting ? 'Submitting…' : 'Give Instruction'}
          </button>
          <button
            className="quiet-button quiet-button-small"
            type="button"
            onClick={() => void submitInstruction(true)}
            disabled={submitting || isTerminal || detail.goal.status === 'COMPLETED'}
          >
            {submitting ? 'Working…' : 'Submit & Continue'}
          </button>
        </div>
      </form>
      {error !== undefined && (
        <p className="goal-instruction-feedback goal-instruction-error" role="alert">
          {error}
        </p>
      )}
      {success !== undefined && <p className="goal-instruction-feedback">{success}</p>}
      <div className="goal-instruction-history">
        <div className="goal-instruction-history-heading">
          <span className="eyebrow">INSTRUCTION HISTORY</span>
          <small>{instructions.length}</small>
        </div>
        {instructions.length === 0 ? (
          <small className="goal-instruction-empty">No instructions recorded yet.</small>
        ) : (
          instructions.map((instruction) => (
            <article
              className={`goal-instruction-row goal-instruction-status-${instruction.status.toLowerCase()}`}
              key={instruction.id}
            >
              <div className="goal-instruction-row-heading">
                <strong>{instructionKindLabel(instruction.kind)}</strong>
                <span>{statusLabel(instruction.status)}</span>
                <small>{formatTimestamp(instruction.createdAt)}</small>
              </div>
              <p>{instruction.content}</p>
              <small>
                base revision {instruction.baseRevision}
                {instruction.appliedRevision === undefined
                  ? ''
                  : ` · applied revision ${instruction.appliedRevision}`}
              </small>
              {instruction.decisionReason !== undefined && (
                <small className="goal-instruction-reason">{instruction.decisionReason}</small>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function RoadmapEditor({
  detail,
  onRefresh,
  onReload,
}: {
  detail: GoalDetail;
  onRefresh: () => void;
  onReload: () => Promise<void>;
}) {
  const [editingTaskId, setEditingTaskId] = useState<string>();
  const [editTitle, setEditTitle] = useState('');
  const [editObjective, setEditObjective] = useState('');
  const [editCriteria, setEditCriteria] = useState('');
  const [editMaxAttempts, setEditMaxAttempts] = useState('');
  const [editReason, setEditReason] = useState('');
  const [insertTitle, setInsertTitle] = useState('');
  const [insertObjective, setInsertObjective] = useState('');
  const [insertCriteria, setInsertCriteria] = useState('');
  const [insertMaxAttempts, setInsertMaxAttempts] = useState('3');
  const [insertReason, setInsertReason] = useState('');
  const [skipTaskId, setSkipTaskId] = useState<string>();
  const [skipReason, setSkipReason] = useState('');
  const [reorderReason, setReorderReason] = useState('');
  const [reorderOrder, setReorderOrder] = useState<readonly string[]>([]);
  const [busyAction, setBusyAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const editableTasks = useMemo(
    () =>
      detail.tasks.filter(
        (task) =>
          task.status === 'PENDING' &&
          task.startedAt === undefined &&
          detail.goal.roadmap.find((item) => item.id === task.id)?.status !== 'LOCKED',
      ),
    [detail],
  );
  const reorderableTasks = useMemo(
    () => editableTasks.filter((task) => task.tentative),
    [editableTasks],
  );
  const reorderableIds = useMemo(() => reorderableTasks.map((task) => task.id), [reorderableTasks]);
  const editingTask = editableTasks.find((task) => task.id === editingTaskId);
  const isTerminal = ['COMPLETED', 'FAILED', 'ABORTED'].includes(detail.goal.status);
  const orderChanged =
    reorderOrder.length === reorderableIds.length &&
    reorderOrder.some((taskId, index) => taskId !== reorderableIds[index]);

  useEffect(() => {
    setReorderOrder((current) => reconcileTaskOrder(current, reorderableIds));
    if (editingTaskId !== undefined && !reorderableIds.includes(editingTaskId)) {
      setEditingTaskId(undefined);
    }
    if (skipTaskId !== undefined && !reorderableIds.includes(skipTaskId)) {
      setSkipTaskId(undefined);
    }
  }, [detail.goal.id, detail.goal.activeRevision, editingTaskId, reorderableIds, skipTaskId]);

  const setMutationFeedback = (message: string, isError = false) => {
    if (message.length === 0) {
      setError(undefined);
      setSuccess(undefined);
      return;
    }
    if (isError) {
      setError(message);
      setSuccess(undefined);
    } else {
      setSuccess(message);
      setError(undefined);
    }
  };

  const reloadAfterMutation = async () => {
    onRefresh();
    await onReload();
  };

  const confirmMutation = (description: string): boolean => {
    if (typeof globalThis.confirm !== 'function') return true;
    return globalThis.confirm(
      `This will create roadmap revision ${detail.goal.activeRevision + 1}. ${description}`,
    );
  };

  const handleMutationError = (cause: unknown, action: string) => {
    const conflict = cause instanceof DashboardApiError && cause.status === 409;
    setMutationFeedback(
      conflict
        ? `Roadmap changed before ${action}. The latest revision was reloaded; your draft was kept.`
        : formatError(cause),
      true,
    );
    if (conflict) void onReload();
  };

  const startEditing = (task: StoredTask) => {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditObjective(task.objective);
    setEditCriteria(task.acceptanceCriteria.join('\n'));
    setEditMaxAttempts(String(task.maxAttempts));
    setEditReason('');
    setMutationFeedback('');
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editingTask === undefined || isTerminal || busyAction !== undefined) return;
    const title = editTitle.trim();
    const objective = editObjective.trim();
    const acceptanceCriteria = splitCriteria(editCriteria);
    const reason = editReason.trim();
    const maxAttempts = Number(editMaxAttempts.trim());
    if (title.length === 0 || objective.length === 0 || acceptanceCriteria.length === 0) {
      setMutationFeedback(
        'Title, objective, and at least one acceptance criterion are required.',
        true,
      );
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      setMutationFeedback('Max attempts must be an integer from 1 to 10.', true);
      return;
    }
    if (reason.length === 0) {
      setMutationFeedback('A reason is required for every roadmap revision.', true);
      return;
    }
    if (!confirmMutation(`Only the future Task “${editingTask.title}” will be changed.`)) return;
    const patch: {
      title?: string;
      objective?: string;
      acceptanceCriteria?: readonly string[];
      maxAttempts?: number;
    } = {};
    if (title !== editingTask.title) patch.title = title;
    if (objective !== editingTask.objective) patch.objective = objective;
    if (JSON.stringify(acceptanceCriteria) !== JSON.stringify(editingTask.acceptanceCriteria)) {
      patch.acceptanceCriteria = acceptanceCriteria;
    }
    if (maxAttempts !== editingTask.maxAttempts) patch.maxAttempts = maxAttempts;
    if (Object.keys(patch).length === 0) {
      setMutationFeedback('Change at least one future Task field before saving.', true);
      return;
    }
    setBusyAction(`edit:${editingTask.id}`);
    try {
      await api.updateGoalTask(detail.goal.id, editingTask.id, {
        patch,
        reason,
        expectedRevision: detail.goal.activeRevision,
        idempotencyKey: createClientRequestId('roadmap-edit'),
      });
      await reloadAfterMutation();
      setEditingTaskId(undefined);
      setMutationFeedback('Future Task contract updated and recorded as a new revision.');
    } catch (cause) {
      handleMutationError(cause, 'editing the Task');
    } finally {
      setBusyAction(undefined);
    }
  };

  const submitInsert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTerminal || busyAction !== undefined) return;
    const title = insertTitle.trim();
    const objective = insertObjective.trim();
    const acceptanceCriteria = splitCriteria(insertCriteria);
    const reason = insertReason.trim();
    const maxAttempts = Number(insertMaxAttempts.trim());
    if (title.length === 0 || objective.length === 0 || acceptanceCriteria.length === 0) {
      setMutationFeedback(
        'Title, objective, and at least one acceptance criterion are required.',
        true,
      );
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      setMutationFeedback('Max attempts must be an integer from 1 to 10.', true);
      return;
    }
    if (reason.length === 0) {
      setMutationFeedback('A reason is required for every roadmap revision.', true);
      return;
    }
    if (!confirmMutation(`A new tentative Task “${title}” will be appended to the future work.`)) {
      return;
    }
    setBusyAction('insert');
    try {
      await api.insertGoalTask(detail.goal.id, {
        title,
        objective,
        acceptanceCriteria,
        maxAttempts,
        tentative: true,
        reason,
        expectedRevision: detail.goal.activeRevision,
        idempotencyKey: createClientRequestId('roadmap-insert'),
      });
      await reloadAfterMutation();
      setInsertTitle('');
      setInsertObjective('');
      setInsertCriteria('');
      setInsertMaxAttempts('3');
      setInsertReason('');
      setMutationFeedback('Tentative future Task inserted and recorded as a new revision.');
    } catch (cause) {
      handleMutationError(cause, 'inserting a Task');
    } finally {
      setBusyAction(undefined);
    }
  };

  const submitSkip = async (task: StoredTask) => {
    if (isTerminal || busyAction !== undefined) return;
    const reason = skipReason.trim();
    if (reason.length === 0) {
      setMutationFeedback('A reason is required before skipping a Task.', true);
      return;
    }
    if (!confirmMutation(`The tentative future Task “${task.title}” will be marked skipped.`)) {
      return;
    }
    setBusyAction(`skip:${task.id}`);
    try {
      await api.skipGoalTask(detail.goal.id, task.id, {
        reason,
        expectedRevision: detail.goal.activeRevision,
        idempotencyKey: createClientRequestId('roadmap-skip'),
      });
      await reloadAfterMutation();
      setSkipTaskId(undefined);
      setSkipReason('');
      setMutationFeedback('Future Task skipped and recorded as a new revision.');
    } catch (cause) {
      handleMutationError(cause, 'skipping the Task');
    } finally {
      setBusyAction(undefined);
    }
  };

  const submitReorder = async () => {
    if (isTerminal || busyAction !== undefined || !orderChanged) return;
    const reason = reorderReason.trim();
    if (reason.length === 0) {
      setMutationFeedback('A reason is required before reordering future Tasks.', true);
      return;
    }
    if (!confirmMutation('Only the order of unstarted tentative Tasks will change.')) return;
    setBusyAction('reorder');
    try {
      await api.reorderGoalTasks(detail.goal.id, {
        taskIds: reorderOrder,
        reason,
        expectedRevision: detail.goal.activeRevision,
        idempotencyKey: createClientRequestId('roadmap-reorder'),
      });
      await reloadAfterMutation();
      setReorderReason('');
      setMutationFeedback('Future Task order updated and recorded as a new revision.');
    } catch (cause) {
      handleMutationError(cause, 'reordering Tasks');
    } finally {
      setBusyAction(undefined);
    }
  };

  const moveTask = (taskId: string, direction: -1 | 1) => {
    setReorderOrder((current) => {
      const index = current.indexOf(taskId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const currentTaskId = next[index];
      const nextTaskId = next[nextIndex];
      if (currentTaskId === undefined || nextTaskId === undefined) return current;
      next[index] = nextTaskId;
      next[nextIndex] = currentTaskId;
      return next;
    });
  };

  return (
    <section className="roadmap-editor" aria-label="Roadmap editor">
      <details open>
        <summary>
          <span className="eyebrow">ROADMAP CONTROL</span>
          <strong>Future Task plan</strong>
          <span className="roadmap-editor-revision">revision {detail.goal.activeRevision}</span>
        </summary>
        {isTerminal ? (
          <p className="roadmap-editor-note">Terminal Goals cannot be edited.</p>
        ) : (
          <p className="roadmap-editor-note">
            Only unstarted, unlocked Tasks are shown. Every change creates an auditable revision;
            running and historical Tasks are protected.
          </p>
        )}
        {error !== undefined && (
          <p className="roadmap-editor-feedback roadmap-editor-error" role="alert">
            {error}
          </p>
        )}
        {success !== undefined && <p className="roadmap-editor-feedback">{success}</p>}
        {reorderableTasks.length > 0 && (
          <div className="roadmap-order-list">
            <div className="roadmap-editor-section-heading">
              <span className="eyebrow">FUTURE ORDER</span>
              <small>{reorderableTasks.length} tentative Task(s)</small>
            </div>
            {reorderOrder.map((taskId, index) => {
              const task = reorderableTasks.find((candidate) => candidate.id === taskId);
              if (task === undefined) return null;
              const skipOpen = skipTaskId === task.id;
              return (
                <div className="roadmap-order-row" key={task.id}>
                  <span className="roadmap-order-number">{index + 1}</span>
                  <div className="roadmap-order-copy">
                    <strong>{task.title}</strong>
                    <small>
                      {statusLabel(task.status)} · tentative · {shortId(task.id)}
                    </small>
                  </div>
                  <div className="roadmap-order-actions">
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => moveTask(task.id, -1)}
                      disabled={busyAction !== undefined || index === 0 || isTerminal}
                      aria-label={`Move ${task.title} up`}
                    >
                      ↑
                    </button>
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => moveTask(task.id, 1)}
                      disabled={
                        busyAction !== undefined || index === reorderOrder.length - 1 || isTerminal
                      }
                      aria-label={`Move ${task.title} down`}
                    >
                      ↓
                    </button>
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => startEditing(task)}
                      disabled={busyAction !== undefined || isTerminal}
                    >
                      Edit
                    </button>
                    <button
                      className="quiet-button quiet-button-small quiet-button-danger"
                      type="button"
                      onClick={() => {
                        setSkipTaskId(skipOpen ? undefined : task.id);
                        setSkipReason('');
                      }}
                      disabled={busyAction !== undefined || isTerminal}
                    >
                      Skip
                    </button>
                  </div>
                  {skipOpen && (
                    <div className="roadmap-inline-action">
                      <label>
                        <span>Skip reason</span>
                        <input
                          value={skipReason}
                          onChange={(event) => setSkipReason(event.target.value)}
                          placeholder="Why is this future Task no longer needed?"
                          maxLength={4_000}
                          disabled={busyAction !== undefined}
                        />
                      </label>
                      <button
                        className="quiet-button quiet-button-small quiet-button-danger"
                        type="button"
                        onClick={() => void submitSkip(task)}
                        disabled={busyAction !== undefined}
                      >
                        {busyAction === `skip:${task.id}` ? 'Skipping…' : 'Confirm skip'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {orderChanged && (
              <div className="roadmap-reorder-submit">
                <label>
                  <span>Reorder reason</span>
                  <input
                    value={reorderReason}
                    onChange={(event) => setReorderReason(event.target.value)}
                    placeholder="Why should these future Tasks run in this order?"
                    maxLength={4_000}
                    disabled={busyAction !== undefined}
                  />
                </label>
                <button
                  className="quiet-button quiet-button-small"
                  type="button"
                  onClick={() => void submitReorder()}
                  disabled={busyAction !== undefined}
                >
                  {busyAction === 'reorder' ? 'Saving…' : 'Save order'}
                </button>
              </div>
            )}
          </div>
        )}
        {editingTask !== undefined && (
          <form className="roadmap-task-form" onSubmit={(event) => void submitEdit(event)}>
            <div className="roadmap-editor-section-heading">
              <span className="eyebrow">EDIT FUTURE TASK</span>
              <small>{editingTask.title}</small>
            </div>
            <label>
              <span>Title</span>
              <input
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                maxLength={200}
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Objective</span>
              <textarea
                value={editObjective}
                onChange={(event) => setEditObjective(event.target.value)}
                rows={2}
                maxLength={16_000}
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Acceptance criteria (one per line)</span>
              <textarea
                value={editCriteria}
                onChange={(event) => setEditCriteria(event.target.value)}
                rows={3}
                maxLength={16_000}
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Max attempts</span>
              <input
                type="number"
                min="1"
                max="10"
                step="1"
                value={editMaxAttempts}
                onChange={(event) => setEditMaxAttempts(event.target.value)}
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Revision reason</span>
              <input
                value={editReason}
                onChange={(event) => setEditReason(event.target.value)}
                maxLength={4_000}
                placeholder="Explain the safe future change."
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <div className="roadmap-form-actions">
              <button
                className="quiet-button quiet-button-small"
                type="submit"
                disabled={busyAction !== undefined}
              >
                {busyAction?.startsWith('edit:') ? 'Saving…' : 'Save Task revision'}
              </button>
              <button
                className="quiet-button quiet-button-small"
                type="button"
                onClick={() => setEditingTaskId(undefined)}
                disabled={busyAction !== undefined}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {!isTerminal && (
          <form
            className="roadmap-task-form roadmap-insert-form"
            onSubmit={(event) => void submitInsert(event)}
          >
            <div className="roadmap-editor-section-heading">
              <span className="eyebrow">INSERT FUTURE TASK</span>
              <small>Creates a tentative Task after the current future boundary.</small>
            </div>
            <label>
              <span>Title</span>
              <input
                value={insertTitle}
                onChange={(event) => setInsertTitle(event.target.value)}
                maxLength={200}
                placeholder="New verification or implementation step"
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Objective</span>
              <textarea
                value={insertObjective}
                onChange={(event) => setInsertObjective(event.target.value)}
                rows={2}
                maxLength={16_000}
                placeholder="What should this future Task accomplish?"
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Acceptance criteria (one per line)</span>
              <textarea
                value={insertCriteria}
                onChange={(event) => setInsertCriteria(event.target.value)}
                rows={2}
                maxLength={16_000}
                placeholder="The expected evidence is available."
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Max attempts</span>
              <input
                type="number"
                min="1"
                max="10"
                step="1"
                value={insertMaxAttempts}
                onChange={(event) => setInsertMaxAttempts(event.target.value)}
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <label>
              <span>Revision reason</span>
              <input
                value={insertReason}
                onChange={(event) => setInsertReason(event.target.value)}
                maxLength={4_000}
                placeholder="Why is this future Task needed?"
                disabled={busyAction !== undefined}
                required
              />
            </label>
            <div className="roadmap-form-actions">
              <button
                className="quiet-button quiet-button-small"
                type="submit"
                disabled={busyAction !== undefined}
              >
                {busyAction === 'insert' ? 'Inserting…' : 'Insert Task'}
              </button>
            </div>
          </form>
        )}
        {!isTerminal && editableTasks.length === 0 && (
          <p className="roadmap-editor-note">No editable future Tasks are available right now.</p>
        )}
      </details>
    </section>
  );
}

function GoalHistoryList({
  goals,
  selectedGoalId,
  onSelectGoal,
}: {
  goals: readonly StoredGoal[];
  selectedGoalId: string | undefined;
  onSelectGoal: (goalId: string) => void;
}) {
  const groups = [
    {
      key: 'active',
      label: 'Active',
      items: goals.filter(
        (goal) =>
          goal.archivedAt === undefined &&
          ['CREATED', 'PLANNING', 'RUNNING', 'VERIFYING', 'PAUSED', 'NEEDS_HUMAN'].includes(
            goal.status,
          ),
      ),
    },
    {
      key: 'history',
      label: 'History',
      items: goals.filter(
        (goal) =>
          goal.archivedAt === undefined && ['COMPLETED', 'FAILED', 'ABORTED'].includes(goal.status),
      ),
    },
    {
      key: 'archived',
      label: 'Archived',
      items: goals.filter((goal) => goal.archivedAt !== undefined),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="goal-history-list">
      {groups.map((group) => (
        <section key={group.key} aria-label={`${group.label} Goals`}>
          <div className="goal-history-section-heading">
            <span className="eyebrow">{group.label}</span>
            <small>{group.items.length}</small>
          </div>
          <div className="goal-list">
            {group.items.map((goal) => (
              <button
                className={`goal-row ${selectedGoalId === goal.id ? 'goal-row-selected' : ''}`}
                key={goal.id}
                type="button"
                onClick={() => onSelectGoal(goal.id)}
              >
                <div className="goal-row-copy">
                  <strong>{goal.prompt}</strong>
                  <small>
                    {goal.provider} · {goal.workspace} · updated {formatTimestamp(goal.updatedAt)}
                    {goal.archivedAt === undefined ? '' : ' · archived'}
                  </small>
                </div>
                <span className={`goal-status goal-status-${goal.status.toLowerCase()}`}>
                  {statusLabel(goal.status)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function mergeGoals(
  current: readonly StoredGoal[],
  incoming: readonly StoredGoal[],
): readonly StoredGoal[] {
  const byId = new Map(current.map((goal) => [goal.id, goal]));
  for (const goal of incoming) byId.set(goal.id, goal);
  return [...byId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
  );
}

function loadSelectionFromUrl(key: 'goal' | 'session' | 'task' | 'attempt'): string | undefined {
  if (typeof globalThis.location === 'undefined') return undefined;
  const value = new URLSearchParams(globalThis.location.search).get(key);
  return value === null || value.length === 0 ? undefined : value;
}

function syncSelectionToUrl(
  key: 'goal' | 'session' | 'task' | 'attempt',
  value: string | undefined,
): void {
  if (typeof globalThis.history === 'undefined' || typeof globalThis.location === 'undefined') {
    return;
  }
  const params = new URLSearchParams(globalThis.location.search);
  if (value === undefined) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  const next = `${globalThis.location.pathname}${query.length === 0 ? '' : `?${query}`}${globalThis.location.hash}`;
  globalThis.history.replaceState(null, '', next);
}

function loadGoalHistoryFilter(): {
  status: 'all' | StoredGoal['status'];
  provider: string;
  workspace: string;
  query: string;
  includeArchived: boolean;
} {
  const params = new URLSearchParams(
    typeof globalThis.location === 'undefined' ? '' : globalThis.location.search,
  );
  const statusValue = params.get('goalStatus');
  const validStatuses = [
    'CREATED',
    'PLANNING',
    'RUNNING',
    'VERIFYING',
    'PAUSED',
    'NEEDS_HUMAN',
    'COMPLETED',
    'FAILED',
    'ABORTED',
  ] as const;
  const status = validStatuses.includes(statusValue as (typeof validStatuses)[number])
    ? (statusValue as StoredGoal['status'])
    : 'all';
  return {
    status,
    provider: params.get('goalProvider') ?? '',
    workspace: params.get('goalWorkspace') ?? '',
    query: params.get('goalQuery') ?? '',
    includeArchived: params.get('goalArchived') === 'true',
  };
}

function syncGoalHistoryFilter(filter: {
  status: 'all' | StoredGoal['status'];
  provider: string;
  workspace: string;
  query: string;
  includeArchived: boolean;
}): void {
  if (typeof globalThis.history === 'undefined' || typeof globalThis.location === 'undefined') {
    return;
  }
  const params = new URLSearchParams(globalThis.location.search);
  for (const key of ['goalStatus', 'goalProvider', 'goalWorkspace', 'goalQuery', 'goalArchived']) {
    params.delete(key);
  }
  if (filter.status !== 'all') params.set('goalStatus', filter.status);
  if (filter.provider.trim() !== '') params.set('goalProvider', filter.provider.trim());
  if (filter.workspace.trim() !== '') params.set('goalWorkspace', filter.workspace.trim());
  if (filter.query.trim() !== '') params.set('goalQuery', filter.query.trim());
  if (filter.includeArchived) params.set('goalArchived', 'true');
  const query = params.toString();
  const next = `${globalThis.location.pathname}${query.length === 0 ? '' : `?${query}`}${globalThis.location.hash}`;
  globalThis.history.replaceState(null, '', next);
}

function NotificationCenter({
  goals,
  onSelectGoal,
}: {
  goals: readonly StoredGoal[];
  onSelectGoal: (goalId: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<
    'all' | StoredOrchestratorNotification['status']
  >('all');
  const [notifications, setNotifications] = useState<readonly StoredOrchestratorNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionId, setActionId] = useState<string>();
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const requestId = ++requestIdRef.current;
      if (cursor === undefined) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await api.listOrchestratorNotifications({
          limit: 20,
          ...(statusFilter === 'all' ? {} : { status: statusFilter }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (requestId !== requestIdRef.current) return;
        setNotifications((current) =>
          cursor === undefined ? page.items : mergeNotifications(current, page.items),
        );
        setNextCursor(page.nextCursor);
        setError(undefined);
      } catch (cause) {
        if (requestId !== requestIdRef.current) return;
        setError(
          cause instanceof Error ? cause.message : 'Unable to load orchestrator notifications.',
        );
        if (cursor === undefined) setNotifications([]);
      } finally {
        if (requestId === requestIdRef.current) {
          if (cursor === undefined) setLoading(false);
          else setLoadingMore(false);
        }
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    void load();
  }, [goals, load]);

  const transition = async (
    notification: StoredOrchestratorNotification,
    status: 'READ' | 'DISMISSED',
  ) => {
    setActionId(notification.id);
    try {
      const updated =
        status === 'READ'
          ? await api.markOrchestratorNotificationRead(notification.id)
          : await api.dismissOrchestratorNotification(notification.id);
      setNotifications((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update notification.');
    } finally {
      setActionId(undefined);
    }
  };

  const unreadCount = notifications.filter(
    (notification) => notification.status === 'PENDING' || notification.status === 'DELIVERED',
  ).length;

  return (
    <section className="notification-center" aria-label="Orchestrator notification center">
      <div className="notification-center-heading">
        <div>
          <span className="eyebrow">NOTIFICATIONS</span>
          <strong>Recent Orchestrator alerts</strong>
          <small>
            {unreadCount > 0 ? `${unreadCount} unread in the loaded history` : 'No unread alerts'}
          </small>
        </div>
        <div className="notification-center-actions">
          <label className="filter-label">
            <span className="sr-only">Filter orchestrator notifications</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(
                  event.target.value as 'all' | StoredOrchestratorNotification['status'],
                )
              }
            >
              <option value="all">All</option>
              <option value="PENDING">Unread</option>
              <option value="DELIVERED">Delivered</option>
              <option value="READ">Read</option>
              <option value="DISMISSED">Dismissed</option>
            </select>
          </label>
          <button
            className="quiet-button quiet-button-small"
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>
      {error !== undefined && <p className="notification-center-error">{error}</p>}
      {loading ? (
        <p className="empty-state">Loading notifications…</p>
      ) : notifications.length === 0 ? (
        <p className="empty-state">No notifications in this view.</p>
      ) : (
        <div className="notification-list">
          {notifications.map((notification) => {
            const goal = goals.find((item) => item.id === notification.goalId);
            const taskId =
              typeof notification.payload.taskId === 'string' &&
              notification.payload.taskId.length > 0
                ? notification.payload.taskId
                : undefined;
            const hasTask = taskId !== undefined;
            const goalAvailable = goal !== undefined && goal.archivedAt === undefined;
            return (
              <article
                className={`notification-row notification-row-${notification.status.toLowerCase()}`}
                key={notification.id}
              >
                <div className="notification-row-copy">
                  <strong>{notificationKindLabel(notification.kind)}</strong>
                  <small>
                    Goal {shortId(notification.goalId)}
                    {hasTask ? ` · Task ${shortId(taskId)}` : ''} ·{' '}
                    {formatTimestamp(notification.createdAt)}
                  </small>
                  <span>{notificationStatusLabel(notification.status)}</span>
                </div>
                <div className="notification-row-actions">
                  <button
                    className="quiet-button quiet-button-small"
                    type="button"
                    onClick={() => onSelectGoal(notification.goalId)}
                    disabled={!goalAvailable}
                    title={
                      goalAvailable
                        ? 'Open the related Goal'
                        : 'This Goal is archived or no longer available'
                    }
                  >
                    {goalAvailable ? 'Open Goal' : 'Unavailable'}
                  </button>
                  {notification.status !== 'READ' && notification.status !== 'DISMISSED' && (
                    <button
                      className="quiet-button quiet-button-small"
                      type="button"
                      onClick={() => void transition(notification, 'READ')}
                      disabled={actionId === notification.id}
                    >
                      Mark read
                    </button>
                  )}
                  {notification.status !== 'DISMISSED' && (
                    <button
                      className="quiet-button quiet-button-small quiet-button-danger"
                      type="button"
                      onClick={() => void transition(notification, 'DISMISSED')}
                      disabled={actionId === notification.id}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {nextCursor !== undefined && (
        <button
          className="quiet-button quiet-button-small notification-load-more"
          type="button"
          onClick={() => void load(nextCursor)}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

function mergeNotifications(
  current: readonly StoredOrchestratorNotification[],
  incoming: readonly StoredOrchestratorNotification[],
): readonly StoredOrchestratorNotification[] {
  const byId = new Map(current.map((notification) => [notification.id, notification]));
  for (const notification of incoming) byId.set(notification.id, notification);
  return [...byId.values()].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
}

function notificationKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    'needs-human': 'Needs human attention',
    approval: 'Approval requested',
    'budget-warning': 'Budget warning',
    'budget-exceeded': 'Budget exceeded',
    completed: 'Goal completed',
    failed: 'Goal failed',
    'recovery-failed': 'Recovery failed',
  };
  return labels[kind] ?? 'Orchestrator alert';
}

function instructionKindLabel(kind: StoredGoalInstruction['kind']): string {
  const labels: Record<StoredGoalInstruction['kind'], string> = {
    clarification: 'Clarification',
    constraint: 'Constraint',
    priority: 'Priority',
    'approval-context': 'Approval context',
    general: 'General instruction',
  };
  return labels[kind];
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unable to submit the instruction.';
}

function createClientRequestId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  return `${prefix}:${randomUUID === undefined ? `${Date.now()}-${Math.random().toString(36).slice(2)}` : randomUUID()}`;
}

function splitCriteria(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);
}

function reconcileTaskOrder(
  current: readonly string[],
  expected: readonly string[],
): readonly string[] {
  const expectedSet = new Set(expected);
  const preserved = current.filter((taskId) => expectedSet.has(taskId));
  const missing = expected.filter((taskId) => !preserved.includes(taskId));
  return [...preserved, ...missing];
}

function notificationStatusLabel(status: StoredOrchestratorNotification['status']): string {
  switch (status) {
    case 'PENDING':
      return 'Unread';
    case 'DELIVERED':
      return 'Delivered';
    case 'READ':
      return 'Read';
    case 'DISMISSED':
      return 'Dismissed';
  }
}

function shortId(identifier: string): string {
  return identifier.length > 18 ? `${identifier.slice(0, 8)}…${identifier.slice(-6)}` : identifier;
}

function NotificationControl({
  state,
  mode,
  onEnable,
  onModeChange,
}: {
  state: NotificationState;
  mode: OrchestratorNotificationMode;
  onEnable: () => void;
  onModeChange: (mode: OrchestratorNotificationMode) => void;
}) {
  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return (
      <div className="notification-control">
        <span className="notification-status">Notifications enabled</span>
        <NotificationModeSelect mode={mode} onChange={onModeChange} />
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <div className="notification-control">
        <span className="notification-status">Notifications blocked by browser</span>
        <NotificationModeSelect mode={mode} onChange={onModeChange} />
      </div>
    );
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
        <NotificationModeSelect mode={mode} onChange={onModeChange} />
      </div>
    );
  }
  return (
    <div className="notification-control">
      <button
        className="quiet-button quiet-button-small"
        type="button"
        onClick={onEnable}
        disabled={state === 'requesting'}
      >
        {state === 'requesting' ? 'Requesting…' : 'Enable notifications'}
      </button>
      <NotificationModeSelect mode={mode} onChange={onModeChange} />
    </div>
  );
}

function NotificationModeSelect({
  mode,
  onChange,
}: {
  mode: OrchestratorNotificationMode;
  onChange: (mode: OrchestratorNotificationMode) => void;
}) {
  return (
    <label className="notification-preference">
      <span className="sr-only">Orchestrator notification preference</span>
      <select
        aria-label="Orchestrator notification preference"
        value={mode}
        onChange={(event) => onChange(event.target.value as OrchestratorNotificationMode)}
      >
        <option value="all">Orchestrator: all</option>
        <option value="attention">Orchestrator: failures &amp; human</option>
        <option value="muted">Orchestrator: muted</option>
      </select>
    </label>
  );
}

function loadOrchestratorNotificationMode(): OrchestratorNotificationMode {
  try {
    const value = globalThis.localStorage?.getItem(ORCHESTRATOR_NOTIFICATION_PREFERENCE_KEY);
    return value === 'attention' || value === 'muted' ? value : 'all';
  } catch {
    return 'all';
  }
}

function isOrchestratorNotification(message: DashboardLiveNotification): boolean {
  return (
    message.type === 'goal.created' ||
    message.type === 'goal.updated' ||
    message.type === 'task.created' ||
    message.type === 'task.updated' ||
    message.type === 'attempt.created' ||
    message.type === 'attempt.updated' ||
    message.type === 'verification.created' ||
    message.type === 'goal.metrics.updated' ||
    message.type === 'goal.notification.created' ||
    message.type === 'goal.notification.updated' ||
    (message.type === 'event.appended' && message.goalId !== undefined)
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
  actionBusy,
  onHide,
  onUnhide,
  onDelete,
}: {
  session: StoredSession;
  selected: boolean;
  onSelect: (id: string) => void;
  actionBusy: boolean;
  onHide: () => void;
  onUnhide: () => void;
  onDelete: () => void;
}) {
  const active = session.status === 'starting' || session.status === 'running';
  return (
    <div className={`session-row ${selected ? 'session-row-selected' : ''}`}>
      <button
        className="session-row-main"
        type="button"
        onClick={() => onSelect(session.id)}
        aria-label={`Inspect ${session.provider} ${session.adapter} session`}
      >
        <span className={`status-dot status-${session.status}`} />
        <span className="session-row-copy">
          <strong>
            {session.provider} · {session.adapter}
            {session.hiddenAt !== undefined && <em className="hidden-badge">hidden</em>}
          </strong>
          <small>{session.id}</small>
        </span>
        <span className={`status-pill status-pill-${session.status}`}>
          {statusLabel(session.status)}
        </span>
      </button>
      {!active && (
        <div className="session-row-actions">
          <button
            className="quiet-button quiet-button-small"
            type="button"
            onClick={session.hiddenAt === undefined ? onHide : onUnhide}
            disabled={actionBusy}
          >
            {session.hiddenAt === undefined ? 'Hide' : 'Show'}
          </button>
          <button
            className="quiet-button quiet-button-small quiet-button-danger"
            type="button"
            onClick={onDelete}
            disabled={actionBusy}
          >
            Delete
          </button>
        </div>
      )}
    </div>
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
  session: DashboardSessionDetail;
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
      <SessionGoalReferences session={session} />
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

function SessionGoalReferences({ session }: { session: DashboardSessionDetail }) {
  const references = session.orchestrator?.references ?? [];
  if (references.length === 0) return null;
  return (
    <div className="session-goal-references" aria-label="Orchestrator Goal references">
      <span className="eyebrow">ORCHESTRATOR CONTEXT</span>
      {references.map((reference) => (
        <div className="session-goal-reference" key={reference.attemptId}>
          <strong>Goal {shortId(reference.goalId)}</strong>
          <small>
            {statusLabel(reference.goalStatus)} · Task {shortId(reference.taskId)} ·{' '}
            {reference.taskTitle} · Attempt {reference.attemptNumber} ·{' '}
            {statusLabel(reference.attemptStatus)}
          </small>
        </div>
      ))}
    </div>
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
