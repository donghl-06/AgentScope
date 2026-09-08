import type {
  AgentEvent,
  CommandFinishedPayload,
  CommandStartedPayload,
  MilestonePayload,
  Milestone,
  ProviderEventPayload,
  ProviderInfoPayload,
  SessionFinishedPayload,
  SessionStatus,
  TurnStartedPayload,
  TurnFinishedPayload,
  TurnUpdatedPayload,
  UsageUpdatedPayload,
  TestFailedPayload,
  TestPassedPayload,
  TestStartedPayload,
  VerificationState,
} from '@agentscope/protocol';
import { isTerminalSessionStatus } from '@agentscope/protocol';

import type { SessionState } from '@agentscope/protocol';

type ReducerEvent = AgentEvent;

function activity(
  kind: SessionState['currentActivity'] extends infer T
    ? T extends { kind: infer K }
      ? K
      : never
    : never,
  label: string,
  event: ReducerEvent,
): NonNullable<SessionState['currentActivity']> {
  return { kind, label, startedAt: event.timestamp, source: event.source.adapter };
}

function updateVerification(
  state: SessionState,
  patch: Partial<Omit<VerificationState, 'overall'>>,
): SessionState {
  const verification = { ...state.verification, ...patch };
  const values = [verification.tests, verification.build, verification.typecheck];
  const overall: VerificationState['overall'] = values.includes('failed')
    ? 'failed'
    : values.every((value) => value === 'passed')
      ? 'passed'
      : values.some((value) => value === 'pending' || value === 'passed')
        ? 'pending'
        : 'unknown';
  return { ...state, verification: { ...verification, overall } };
}

function updateMilestone(
  state: SessionState,
  event: ReducerEvent,
  status: 'active' | 'completed',
): SessionState {
  const payload = event.payload as MilestonePayload;
  const existingIndex = state.milestones.findIndex(
    (milestone) => milestone.id === payload.milestoneId,
  );
  const existing = existingIndex < 0 ? undefined : state.milestones[existingIndex];
  if (existing?.status === 'completed') {
    return state;
  }

  const nextMilestone: Milestone =
    status === 'active'
      ? {
          id: payload.milestoneId,
          title: payload.title ?? existing?.title ?? payload.milestoneId,
          status,
          startedAt: existing?.startedAt ?? event.timestamp,
        }
      : {
          id: payload.milestoneId,
          title: payload.title ?? existing?.title ?? payload.milestoneId,
          status,
          ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
          completedAt: event.timestamp,
        };
  const milestones = [...state.milestones];
  if (existingIndex < 0) {
    milestones.push(nextMilestone);
  } else {
    milestones[existingIndex] = nextMilestone;
  }
  return { ...state, milestones };
}

function finishState(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as SessionFinishedPayload;
  if (isTerminalSessionStatus(state.status)) {
    return state;
  }

  const status: SessionStatus =
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
    : { ...state, status, endedAt: event.timestamp };
}

function reduceCommandStarted(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as CommandStartedPayload;
  const kind = payload.commandKind?.toLowerCase();
  if (kind === 'test' || kind === 'unit' || kind === 'integration') {
    return updateVerification(
      { ...state, currentActivity: activity('test', payload.commandName ?? 'test', event) },
      { tests: 'pending' },
    );
  }
  if (kind === 'build') {
    return updateVerification(
      { ...state, currentActivity: activity('command', payload.commandName ?? 'build', event) },
      { build: 'pending' },
    );
  }
  if (kind === 'typecheck') {
    return updateVerification(
      { ...state, currentActivity: activity('command', payload.commandName ?? 'typecheck', event) },
      { typecheck: 'pending' },
    );
  }
  return {
    ...state,
    currentActivity: activity('command', payload.commandName ?? 'command', event),
  };
}

function reduceCommandFinished(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as CommandFinishedPayload;
  const kind = payload.commandKind?.toLowerCase();
  const status = payload.exitCode === 0 ? 'passed' : 'failed';
  if (kind === 'test' || kind === 'unit' || kind === 'integration') {
    return updateVerification(state, { tests: status });
  }
  if (kind === 'build') {
    return updateVerification(state, { build: status });
  }
  if (kind === 'typecheck') {
    return updateVerification(state, { typecheck: status });
  }
  return state;
}

function reduceProviderInfo(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as ProviderInfoPayload;
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      providerInfo: {
        ...state.telemetry?.providerInfo,
        ...payload,
      },
    },
  };
}

function reduceProviderEvent(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as ProviderEventPayload;
  const counts = state.telemetry?.nativeEventCounts ?? {};
  const keys = [
    payload.providerEventType,
    payload.phase === undefined ? undefined : `${payload.providerEventType}/${payload.phase}`,
  ].filter((key): key is string => key !== undefined && key.length > 0);
  const nativeEventCounts = { ...counts };
  for (const key of keys) {
    nativeEventCounts[key] = (nativeEventCounts[key] ?? 0) + 1;
  }
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      nativeEventCounts,
    },
  };
}

function reduceUsage(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as UsageUpdatedPayload;
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      usage: {
        ...state.telemetry?.usage,
        ...payload.usage,
      },
    },
  };
}

function incrementToolCallCount(state: SessionState): SessionState {
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      toolCallCount: (state.telemetry?.toolCallCount ?? 0) + 1,
    },
  };
}

function finishToolCall(state: SessionState, event: ReducerEvent): SessionState {
  const payload = event.payload as { success: boolean };
  return {
    ...state,
    currentActivity: activity('implementation', 'tool call finished', event),
    telemetry: {
      ...state.telemetry,
      toolCallFinishedCount: (state.telemetry?.toolCallFinishedCount ?? 0) + 1,
      toolCallErrorCount: (state.telemetry?.toolCallErrorCount ?? 0) + (payload.success ? 0 : 1),
    },
  };
}

/** Pure, deterministic projection from one normalized event into SessionState. */
export function reduceSessionState(state: SessionState, event: AgentEvent): SessionState {
  if (isTerminalSessionStatus(state.status) && event.type !== 'session_finished') {
    return state;
  }

  switch (event.type) {
    case 'session_started':
      return state.status === 'starting' ? { ...state, status: 'running' } : state;
    case 'turn_started': {
      const payload = event.payload as TurnStartedPayload;
      return {
        ...state,
        status: state.status === 'blocked' ? state.status : 'running',
        currentActivity: activity(
          'implementation',
          payload.title ?? `task ${payload.sequence}`,
          event,
        ),
      };
    }
    case 'turn_updated': {
      const payload = event.payload as TurnUpdatedPayload;
      if (payload.status === 'waiting') {
        return { ...state, currentActivity: activity('planning', 'waiting for input', event) };
      }
      if (payload.status === 'blocked') {
        return {
          ...state,
          status: 'blocked',
          currentActivity: activity('blocked', 'task blocked', event),
        };
      }
      return state;
    }
    case 'turn_finished': {
      const payload = event.payload as TurnFinishedPayload;
      const label =
        payload.reason === 'completed'
          ? 'task completed'
          : payload.reason === 'interrupted'
            ? 'task interrupted'
            : payload.reason === 'blocked'
              ? 'task blocked'
              : 'task failed';
      return {
        ...state,
        currentActivity: activity(
          payload.reason === 'blocked' ? 'blocked' : 'implementation',
          label,
          event,
        ),
      };
    }
    case 'planning':
      return {
        ...state,
        status: state.status === 'blocked' ? state.status : 'running',
        currentActivity: activity('planning', 'planning', event),
      };
    case 'agent_message':
      return {
        ...state,
        status: state.status === 'blocked' ? state.status : 'running',
        currentActivity: activity('implementation', 'agent message', event),
      };
    case 'tool_call_started':
      return incrementToolCallCount({
        ...state,
        currentActivity: activity('implementation', 'tool call', event),
      });
    case 'tool_call_finished':
      return finishToolCall(state, event);
    case 'file_read':
      return { ...state, currentActivity: activity('file', 'read file', event) };
    case 'file_write':
      return { ...state, currentActivity: activity('file', 'write file', event) };
    case 'command_started':
      return reduceCommandStarted(state, event);
    case 'command_finished':
      return reduceCommandFinished(state, event);
    case 'test_started': {
      const payload = event.payload as TestStartedPayload;
      return updateVerification(
        { ...state, currentActivity: activity('test', payload.testKind ?? 'test', event) },
        { tests: 'pending' },
      );
    }
    case 'test_passed': {
      const payload = event.payload as TestPassedPayload;
      return updateVerification(
        { ...state, currentActivity: activity('test', payload.testKind ?? 'test passed', event) },
        { tests: 'passed' },
      );
    }
    case 'test_failed': {
      const payload = event.payload as TestFailedPayload;
      return updateVerification(
        { ...state, currentActivity: activity('test', payload.testKind ?? 'test failed', event) },
        { tests: 'failed' },
      );
    }
    case 'milestone_started':
      return updateMilestone(state, event, 'active');
    case 'milestone_completed':
      return updateMilestone(state, event, 'completed');
    case 'provider_info':
      return reduceProviderInfo(state, event);
    case 'provider_event':
      return reduceProviderEvent(state, event);
    case 'usage_updated':
      return reduceUsage(state, event);
    case 'blocked': {
      const reason = (event.payload as { reason: string }).reason;
      return { ...state, status: 'blocked', currentActivity: activity('blocked', reason, event) };
    }
    case 'unblocked':
      return state.status === 'blocked' ? { ...state, status: 'running' } : state;
    case 'error':
      return { ...state, status: 'failed', endedAt: event.timestamp };
    case 'session_finished':
      return finishState(state, event);
    default:
      return state;
  }
}
