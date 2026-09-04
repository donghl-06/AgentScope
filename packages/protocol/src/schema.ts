import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AGENT_EVENT_TYPES, type AgentEvent } from './events.js';
import type { SessionState } from './session.js';

const eventTypeSchema = Type.Union(
  AGENT_EVENT_TYPES.map((eventType) => Type.Literal(eventType)) as unknown as [
    TSchema,
    ...TSchema[],
  ],
);

const sourceSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    client: Type.String({ minLength: 1 }),
    environment: Type.String({ minLength: 1 }),
    adapter: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    timestamp: Type.Number({ minimum: 0 }),
    source: sourceSchema,
    type: eventTypeSchema,
    payload: Type.Unknown(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    rawRef: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

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
  },
  { additionalProperties: false },
);

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
