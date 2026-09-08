import type {
  AgentEvent,
  SessionState,
  TurnFinishedPayload,
  TurnStartedPayload,
  TurnState,
  TurnStatus,
  TurnUpdatedPayload,
} from '@agentscope/protocol';
import { isTerminalTurnStatus } from '@agentscope/protocol';

import { reduceSessionState } from './session-reducer.js';

function sessionStatusForTurn(status: TurnStatus): SessionState['status'] {
  if (status === 'queued') return 'starting';
  if (status === 'waiting') return 'running';
  return status;
}

function turnStatusForSession(status: SessionState['status']): TurnStatus {
  if (status === 'starting') return 'queued';
  if (status === 'running') return 'running';
  return status;
}

function projectObserverEvent(state: TurnState, event: AgentEvent): TurnState {
  if (isTerminalTurnStatus(state.status)) return state;
  const sessionState: SessionState = {
    sessionId: state.sessionId,
    status: sessionStatusForTurn(state.status),
    startedAt: state.startedAt ?? state.submittedAt,
    ...(state.endedAt === undefined ? {} : { endedAt: state.endedAt }),
    ...(state.currentActivity === undefined ? {} : { currentActivity: state.currentActivity }),
    milestones: [],
    progress: state.progress,
    ...(state.eta === undefined ? {} : { eta: state.eta }),
    verification: state.verification,
    ...(state.telemetry === undefined ? {} : { telemetry: state.telemetry }),
  };
  const projected = reduceSessionState(sessionState, event);
  const status = turnStatusForSession(projected.status);
  const base = {
    ...state,
    status,
    ...(projected.currentActivity === undefined
      ? {}
      : { currentActivity: projected.currentActivity }),
    progress: projected.progress,
    ...(projected.eta === undefined ? {} : { eta: projected.eta }),
    verification: projected.verification,
    ...(projected.telemetry === undefined ? {} : { telemetry: projected.telemetry }),
  };
  if (isTerminalTurnStatus(status))
    return { ...base, endedAt: projected.endedAt ?? event.timestamp };
  const withoutEnd = { ...base };
  delete withoutEnd.endedAt;
  return withoutEnd;
}

function updateTurn(state: TurnState, payload: TurnUpdatedPayload, timestamp: number): TurnState {
  if (payload.status === undefined) {
    return {
      ...state,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.currentActivity === undefined
        ? {}
        : { currentActivity: payload.currentActivity }),
      ...(payload.progress === undefined ? {} : { progress: payload.progress }),
      ...(payload.eta === undefined ? {} : { eta: payload.eta }),
      ...(payload.verification === undefined ? {} : { verification: payload.verification }),
    };
  }
  const status = payload.status;
  if (isTerminalTurnStatus(state.status)) return state;
  const base = {
    ...state,
    status,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.currentActivity === undefined ? {} : { currentActivity: payload.currentActivity }),
    ...(payload.progress === undefined ? {} : { progress: payload.progress }),
    ...(payload.eta === undefined ? {} : { eta: payload.eta }),
    ...(payload.verification === undefined ? {} : { verification: payload.verification }),
    ...(status === 'queued' || state.startedAt !== undefined ? {} : { startedAt: timestamp }),
  };
  if (isTerminalTurnStatus(status)) return { ...base, endedAt: timestamp };
  const withoutEnd = { ...base };
  delete withoutEnd.endedAt;
  return withoutEnd;
}

function finishTurn(state: TurnState, payload: TurnFinishedPayload, timestamp: number): TurnState {
  if (isTerminalTurnStatus(state.status)) return state;
  const status: TurnStatus =
    payload.reason === 'completed'
      ? state.verification.overall === 'failed'
        ? 'failed'
        : 'completed'
      : payload.reason === 'interrupted'
        ? 'interrupted'
        : payload.reason === 'blocked'
          ? 'blocked'
          : 'failed';
  return status === 'blocked'
    ? { ...state, status }
    : {
        ...state,
        status,
        endedAt: timestamp,
      };
}

/** Pure, deterministic projection for one V1 turn. */
export function reduceTurnState(state: TurnState, event: AgentEvent): TurnState {
  const turnId =
    event.type === 'turn_started' || event.type === 'turn_updated' || event.type === 'turn_finished'
      ? (event.payload as { turnId: string }).turnId
      : undefined;
  if (turnId !== undefined && turnId !== state.turnId) return state;

  switch (event.type) {
    case 'turn_started': {
      if (isTerminalTurnStatus(state.status) || state.status !== 'queued') return state;
      const payload = event.payload as TurnStartedPayload;
      return {
        ...state,
        status: 'running',
        startedAt: event.timestamp,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
        ...(payload.providerTurnId === undefined ? {} : { providerTurnId: payload.providerTurnId }),
      };
    }
    case 'turn_updated':
      return updateTurn(state, event.payload as TurnUpdatedPayload, event.timestamp);
    case 'turn_finished':
      return finishTurn(state, event.payload as TurnFinishedPayload, event.timestamp);
    case 'session_started':
    case 'session_finished':
      return state;
    default:
      return projectObserverEvent(state, event);
  }
}
