import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AGENT_EVENT_TYPES, type AgentEvent, type AgentEventType } from './events.js';
import type { SessionState } from './session.js';
import { TURN_STATUSES, type TurnState } from './turn.js';

const sourceSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    client: Type.String({ minLength: 1 }),
    environment: Type.String({ minLength: 1 }),
    adapter: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const finishReasonSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
  Type.Literal('blocked'),
  Type.Literal('unknown'),
]);
const turnStatusSchema = Type.Union(
  TURN_STATUSES.map((status) => Type.Literal(status)) as unknown as [TSchema, ...TSchema[]],
);
const turnFinishReasonSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
  Type.Literal('blocked'),
  Type.Literal('unknown'),
]);
const payloadSchemas: Record<AgentEventType, TSchema> = {
  session_started: Type.Object({ providerSessionId: Type.Optional(Type.String({ minLength: 1 })) }),
  session_finished: Type.Object({
    reason: finishReasonSchema,
    exitCode: Type.Optional(Type.Number()),
    providerOutcome: Type.Optional(Type.String()),
  }),
  turn_started: Type.Object({
    turnId: Type.String({ minLength: 1 }),
    sequence: Type.Integer({ minimum: 1 }),
    title: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    providerTurnId: Type.Optional(Type.String({ minLength: 1 })),
  }),
  turn_updated: Type.Object({
    turnId: Type.String({ minLength: 1 }),
    status: Type.Optional(turnStatusSchema),
    title: Type.Optional(Type.String()),
    currentActivity: Type.Optional(
      Type.Object({
        kind: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
        startedAt: Type.Number({ minimum: 0 }),
        source: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ),
    progress: Type.Optional(
      Type.Object({
        value: Type.Number({ minimum: 0, maximum: 1 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        reasons: Type.Array(
          Type.Object({
            code: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 }),
          }),
        ),
      }),
    ),
    eta: Type.Optional(
      Type.Object({
        minSeconds: Type.Number({ minimum: 0 }),
        maxSeconds: Type.Number({ minimum: 0 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        reasons: Type.Array(
          Type.Object({
            code: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 }),
          }),
        ),
      }),
    ),
    verification: Type.Optional(
      Type.Object({
        tests: Type.Union([
          Type.Literal('unknown'),
          Type.Literal('pending'),
          Type.Literal('passed'),
          Type.Literal('failed'),
        ]),
        build: Type.Union([
          Type.Literal('unknown'),
          Type.Literal('pending'),
          Type.Literal('passed'),
          Type.Literal('failed'),
        ]),
        typecheck: Type.Union([
          Type.Literal('unknown'),
          Type.Literal('pending'),
          Type.Literal('passed'),
          Type.Literal('failed'),
        ]),
        overall: Type.Union([
          Type.Literal('unknown'),
          Type.Literal('pending'),
          Type.Literal('passed'),
          Type.Literal('failed'),
        ]),
      }),
    ),
  }),
  turn_finished: Type.Object({
    turnId: Type.String({ minLength: 1 }),
    reason: turnFinishReasonSchema,
    exitCode: Type.Optional(Type.Number()),
    providerOutcome: Type.Optional(Type.String()),
  }),
  planning: Type.Object({ summary: Type.Optional(Type.String()) }),
  agent_message: Type.Object({ summary: Type.Optional(Type.String()) }),
  observer_activity: Type.Object({
    kind: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    evidenceSource: Type.String({ minLength: 1 }),
    evidenceKind: Type.String({ minLength: 1 }),
    evidenceKey: Type.String({ minLength: 1 }),
    turnId: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.Optional(Type.String()),
  }),
  tool_call_started: Type.Object({
    toolName: Type.String({ minLength: 1 }),
    toolCallId: Type.Optional(Type.String({ minLength: 1 })),
  }),
  tool_call_finished: Type.Object({
    toolName: Type.String({ minLength: 1 }),
    success: Type.Boolean(),
    toolCallId: Type.Optional(Type.String({ minLength: 1 })),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    errorCode: Type.Optional(Type.String({ minLength: 1 })),
  }),
  file_read: Type.Object({ path: Type.String({ minLength: 1 }) }),
  file_write: Type.Object({ path: Type.String({ minLength: 1 }) }),
  command_started: Type.Object({
    commandKind: Type.Optional(Type.String({ minLength: 1 })),
    commandName: Type.Optional(Type.String({ minLength: 1 })),
  }),
  command_finished: Type.Object({
    commandKind: Type.Optional(Type.String({ minLength: 1 })),
    exitCode: Type.Number(),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  test_started: Type.Object({
    testKind: Type.Optional(Type.String({ minLength: 1 })),
    commandName: Type.Optional(Type.String({ minLength: 1 })),
  }),
  test_passed: Type.Object({
    testKind: Type.Optional(Type.String({ minLength: 1 })),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  test_failed: Type.Object({
    testKind: Type.Optional(Type.String({ minLength: 1 })),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    failureSummary: Type.Optional(Type.String()),
  }),
  milestone_started: Type.Object({
    milestoneId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
  }),
  milestone_completed: Type.Object({
    milestoneId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
  }),
  provider_info: Type.Object({
    providerSessionId: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    cliVersion: Type.Optional(Type.String({ minLength: 1 })),
    permissionMode: Type.Optional(Type.String({ minLength: 1 })),
    outputFormat: Type.Optional(Type.String({ minLength: 1 })),
    capabilityLabels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
    mcpServerCount: Type.Optional(Type.Integer({ minimum: 0 })),
    slashCommandCount: Type.Optional(Type.Integer({ minimum: 0 })),
    agentCount: Type.Optional(Type.Integer({ minimum: 0 })),
    skillCount: Type.Optional(Type.Integer({ minimum: 0 })),
    pluginCount: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  provider_event: Type.Object({
    providerEventType: Type.String({ minLength: 1 }),
    subtype: Type.Optional(Type.String({ minLength: 1 })),
    phase: Type.Optional(Type.String({ minLength: 1 })),
    name: Type.Optional(Type.String({ minLength: 1 })),
    metadata: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
      ),
    ),
  }),
  usage_updated: Type.Object({
    usage: Type.Object({
      inputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      outputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      cacheCreationInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      cacheReadInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      cacheCreation5mInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      cacheCreation1hInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
      thinkingTokens: Type.Optional(Type.Number({ minimum: 0 })),
      thinkingTokensDelta: Type.Optional(Type.Number({ minimum: 0 })),
      reasoningTokens: Type.Optional(Type.Number({ minimum: 0 })),
      serverToolUseRequests: Type.Optional(Type.Number({ minimum: 0 })),
      permissionDenialCount: Type.Optional(Type.Integer({ minimum: 0 })),
      turnCount: Type.Optional(Type.Integer({ minimum: 0 })),
      totalTokens: Type.Optional(Type.Number({ minimum: 0 })),
      totalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
      durationMs: Type.Optional(Type.Number({ minimum: 0 })),
      durationApiMs: Type.Optional(Type.Number({ minimum: 0 })),
      ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
      ttftStreamMs: Type.Optional(Type.Number({ minimum: 0 })),
      timeToRequestMs: Type.Optional(Type.Number({ minimum: 0 })),
      firstContentFrameMs: Type.Optional(Type.Number({ minimum: 0 })),
      queuedTurnCount: Type.Optional(Type.Number({ minimum: 0 })),
      iterations: Type.Optional(Type.Number({ minimum: 0 })),
      inferenceGeo: Type.Optional(Type.String({ minLength: 1 })),
      speed: Type.Optional(Type.String({ minLength: 1 })),
      terminalReason: Type.Optional(Type.String({ minLength: 1 })),
      fastModeState: Type.Optional(Type.String({ minLength: 1 })),
      apiErrorStatus: Type.Optional(Type.Number({ minimum: 0 })),
      model: Type.Optional(Type.String({ minLength: 1 })),
      serviceTier: Type.Optional(Type.String({ minLength: 1 })),
    }),
  }),
  blocked: Type.Object({ reason: Type.String({ minLength: 1 }) }),
  unblocked: Type.Object({ reason: Type.Optional(Type.String()) }),
  error: Type.Object({
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  }),
};

export const AgentEventPayloadSchemas = payloadSchemas;

const eventSchemas = AGENT_EVENT_TYPES.map((eventType) =>
  Type.Object({
    id: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    timestamp: Type.Number({ minimum: 0 }),
    source: sourceSchema,
    type: Type.Literal(eventType),
    payload: payloadSchemas[eventType],
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    rawRef: Type.Optional(Type.String({ minLength: 1 })),
  }),
) as unknown as [TSchema, ...TSchema[]];

export const AgentEventSchema = Type.Union(eventSchemas);

const reasonSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const progressSchema = Type.Object(
  {
    value: Type.Number({ minimum: 0, maximum: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reasons: Type.Array(reasonSchema),
  },
  { additionalProperties: false },
);

const etaSchema = Type.Object(
  {
    minSeconds: Type.Number({ minimum: 0 }),
    maxSeconds: Type.Number({ minimum: 0 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reasons: Type.Array(reasonSchema),
  },
  { additionalProperties: false },
);

const activitySchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    startedAt: Type.Number({ minimum: 0 }),
    source: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const milestoneSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('active'),
      Type.Literal('completed'),
      Type.Literal('failed'),
    ]),
    startedAt: Type.Optional(Type.Number({ minimum: 0 })),
    completedAt: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const workspaceSchema = Type.Object(
  {
    rootPath: Type.String({ minLength: 1 }),
    gitBranch: Type.Optional(Type.String({ minLength: 1 })),
    changedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    lastActivityAt: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const verificationStatusSchema = Type.Union([
  Type.Literal('unknown'),
  Type.Literal('pending'),
  Type.Literal('passed'),
  Type.Literal('failed'),
]);

const verificationSchema = Type.Object(
  {
    tests: verificationStatusSchema,
    build: verificationStatusSchema,
    typecheck: verificationStatusSchema,
    overall: verificationStatusSchema,
  },
  { additionalProperties: false },
);

const providerInfoSchema = Type.Object({
  providerSessionId: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  cliVersion: Type.Optional(Type.String({ minLength: 1 })),
  permissionMode: Type.Optional(Type.String({ minLength: 1 })),
  outputFormat: Type.Optional(Type.String({ minLength: 1 })),
  capabilityLabels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
  mcpServerCount: Type.Optional(Type.Integer({ minimum: 0 })),
  slashCommandCount: Type.Optional(Type.Integer({ minimum: 0 })),
  agentCount: Type.Optional(Type.Integer({ minimum: 0 })),
  skillCount: Type.Optional(Type.Integer({ minimum: 0 })),
  pluginCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

const usageSnapshotSchema = Type.Object({
  inputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  cacheCreationInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  cacheReadInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  cacheCreation5mInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  cacheCreation1hInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
  thinkingTokens: Type.Optional(Type.Number({ minimum: 0 })),
  thinkingTokensDelta: Type.Optional(Type.Number({ minimum: 0 })),
  reasoningTokens: Type.Optional(Type.Number({ minimum: 0 })),
  serverToolUseRequests: Type.Optional(Type.Number({ minimum: 0 })),
  permissionDenialCount: Type.Optional(Type.Integer({ minimum: 0 })),
  turnCount: Type.Optional(Type.Integer({ minimum: 0 })),
  totalTokens: Type.Optional(Type.Number({ minimum: 0 })),
  totalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  durationApiMs: Type.Optional(Type.Number({ minimum: 0 })),
  ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
  ttftStreamMs: Type.Optional(Type.Number({ minimum: 0 })),
  timeToRequestMs: Type.Optional(Type.Number({ minimum: 0 })),
  firstContentFrameMs: Type.Optional(Type.Number({ minimum: 0 })),
  queuedTurnCount: Type.Optional(Type.Number({ minimum: 0 })),
  iterations: Type.Optional(Type.Number({ minimum: 0 })),
  inferenceGeo: Type.Optional(Type.String({ minLength: 1 })),
  speed: Type.Optional(Type.String({ minLength: 1 })),
  terminalReason: Type.Optional(Type.String({ minLength: 1 })),
  fastModeState: Type.Optional(Type.String({ minLength: 1 })),
  apiErrorStatus: Type.Optional(Type.Number({ minimum: 0 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  serviceTier: Type.Optional(Type.String({ minLength: 1 })),
});

const providerTelemetrySchema = Type.Object({
  providerInfo: Type.Optional(providerInfoSchema),
  usage: Type.Optional(usageSnapshotSchema),
  nativeEventCounts: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 0 })),
  ),
  toolCallCount: Type.Optional(Type.Integer({ minimum: 0 })),
  toolCallFinishedCount: Type.Optional(Type.Integer({ minimum: 0 })),
  toolCallErrorCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

const continuationSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('resume'), Type.Literal('continue')]),
    reference: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const conversationLinkSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal('provider-session'), Type.Literal('explicit-resume')]),
  },
  { additionalProperties: false },
);

const sessionStatusSchema = Type.Union([
  Type.Literal('starting'),
  Type.Literal('running'),
  Type.Literal('blocked'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
]);

export const SessionStateSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    status: sessionStatusSchema,
    startedAt: Type.Number({ minimum: 0 }),
    endedAt: Type.Optional(Type.Number({ minimum: 0 })),
    currentActivity: Type.Optional(activitySchema),
    milestones: Type.Array(milestoneSchema),
    progress: progressSchema,
    eta: Type.Optional(etaSchema),
    workspace: Type.Optional(workspaceSchema),
    verification: verificationSchema,
    telemetry: Type.Optional(providerTelemetrySchema),
    continuation: Type.Optional(continuationSchema),
    conversation: Type.Optional(conversationLinkSchema),
  },
  { additionalProperties: false },
);

const turnStateSchema = Type.Object(
  {
    turnId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sequence: Type.Integer({ minimum: 1 }),
    status: turnStatusSchema,
    submittedAt: Type.Number({ minimum: 0 }),
    startedAt: Type.Optional(Type.Number({ minimum: 0 })),
    endedAt: Type.Optional(Type.Number({ minimum: 0 })),
    title: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    providerTurnId: Type.Optional(Type.String({ minLength: 1 })),
    currentActivity: Type.Optional(activitySchema),
    progress: progressSchema,
    eta: Type.Optional(etaSchema),
    verification: verificationSchema,
    telemetry: Type.Optional(providerTelemetrySchema),
  },
  { additionalProperties: false },
);

export const TurnStateSchema = turnStateSchema;

export interface ProtocolValidationErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class ProtocolValidationError extends Error {
  readonly details: readonly ProtocolValidationErrorDetail[];

  constructor(message: string, details: readonly ProtocolValidationErrorDetail[]) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.details = details;
  }
}

function validationDetails(schema: TSchema, value: unknown): ProtocolValidationErrorDetail[] {
  return [...Value.Errors(schema, value)].map((error) => ({
    path: error.path,
    message: error.message,
  }));
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  return Value.Check(AgentEventSchema, value);
}

export function assertAgentEvent(value: unknown): asserts value is AgentEvent {
  const details = validationDetails(AgentEventSchema, value);
  if (details.length > 0) {
    throw new ProtocolValidationError('Invalid AgentEvent.', details);
  }
}

export function isSessionState(value: unknown): value is SessionState {
  return Value.Check(SessionStateSchema, value);
}

export function assertSessionState(value: unknown): asserts value is SessionState {
  const details = validationDetails(SessionStateSchema, value);
  if (details.length > 0) {
    throw new ProtocolValidationError('Invalid SessionState.', details);
  }
}

export function isTurnState(value: unknown): value is TurnState {
  return Value.Check(TurnStateSchema, value);
}

export function assertTurnState(value: unknown): asserts value is TurnState {
  const details = validationDetails(TurnStateSchema, value);
  if (details.length > 0) {
    throw new ProtocolValidationError('Invalid TurnState.', details);
  }
}

/** Return duplicate producer ids in encounter order; Core decides the dedupe policy. */
export function findDuplicateEventIds(events: readonly AgentEvent[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      duplicates.add(event.id);
    } else {
      seen.add(event.id);
    }
  }
  return [...duplicates];
}
