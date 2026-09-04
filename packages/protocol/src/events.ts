export const AGENT_EVENT_TYPES = [
  'session_started',
  'session_finished',
  'planning',
  'agent_message',
  'tool_call_started',
  'tool_call_finished',
  'file_read',
  'file_write',
  'command_started',
  'command_finished',
  'test_started',
  'test_passed',
  'test_failed',
  'milestone_started',
  'milestone_completed',
  'blocked',
  'unblocked',
  'error',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface EventSource {
  readonly provider: string;
  readonly client: string;
  readonly environment: string;
  readonly adapter: string;
}

export type SessionFinishReason = 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown';

export interface SessionStartedPayload {
  readonly providerSessionId?: string;
}

export interface SessionFinishedPayload {
  readonly exitCode?: number;
  readonly reason: SessionFinishReason;
  readonly providerOutcome?: string;
}

export interface PlanningPayload {
  readonly summary?: string;
}

export interface AgentMessagePayload {
  readonly summary?: string;
}

export interface ToolCallStartedPayload {
  readonly toolName: string;
  readonly toolCallId?: string;
}

export interface ToolCallFinishedPayload {
  readonly toolName: string;
  readonly success: boolean;
  readonly durationMs?: number;
  readonly errorCode?: string;
}

export interface FilePayload {
  readonly path: string;
}

export interface CommandStartedPayload {
  readonly commandKind?: string;
  readonly commandName?: string;
}

export interface CommandFinishedPayload {
  readonly exitCode: number;
  readonly durationMs?: number;
}

export interface TestStartedPayload {
  readonly testKind?: string;
  readonly commandName?: string;
}

export interface TestPassedPayload {
  readonly testKind?: string;
  readonly durationMs?: number;
}

export interface TestFailedPayload {
  readonly testKind?: string;
  readonly durationMs?: number;
  readonly failureSummary?: string;
}

export interface MilestonePayload {
  readonly milestoneId: string;
  readonly title?: string;
}

export interface BlockedPayload {
  readonly reason: string;
}

export interface UnblockedPayload {
  readonly reason?: string;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
}

export interface AgentEventPayloadMap {
  readonly session_started: SessionStartedPayload;
  readonly session_finished: SessionFinishedPayload;
  readonly planning: PlanningPayload;
  readonly agent_message: AgentMessagePayload;
  readonly tool_call_started: ToolCallStartedPayload;
  readonly tool_call_finished: ToolCallFinishedPayload;
  readonly file_read: FilePayload;
  readonly file_write: FilePayload;
  readonly command_started: CommandStartedPayload;
  readonly command_finished: CommandFinishedPayload;
  readonly test_started: TestStartedPayload;
  readonly test_passed: TestPassedPayload;
  readonly test_failed: TestFailedPayload;
  readonly milestone_started: MilestonePayload;
  readonly milestone_completed: MilestonePayload;
  readonly blocked: BlockedPayload;
  readonly unblocked: UnblockedPayload;
  readonly error: ErrorPayload;
}

export interface AgentEvent<T = unknown> {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: EventSource;
  readonly type: AgentEventType;
  readonly payload: T;
  readonly confidence: number;
  readonly rawRef?: string;
}

export type AgentEventFor<T extends AgentEventType> = AgentEvent<AgentEventPayloadMap[T]> & {
  readonly type: T;
};
