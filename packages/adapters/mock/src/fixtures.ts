import type { AgentEventType } from '@agentscope/protocol';

export type MockFixtureName =
  'basic-success' | 'test-failure' | 'blocked-then-resumed' | 'interrupted' | 'low-signal';

export interface MockFixtureStep {
  readonly atMs: number;
  readonly type: AgentEventType;
  readonly payload: unknown;
  readonly confidence?: number;
}

export interface MockFixture {
  readonly name: MockFixtureName;
  readonly steps: readonly MockFixtureStep[];
}

const commonStart: MockFixtureStep = { atMs: 0, type: 'session_started', payload: {} };

export const MOCK_FIXTURES: Readonly<Record<MockFixtureName, MockFixture>> = {
  'basic-success': {
    name: 'basic-success',
    steps: [
      commonStart,
      { atMs: 100, type: 'planning', payload: { summary: 'plan' } },
      {
        atMs: 200,
        type: 'milestone_started',
        payload: { milestoneId: 'implementation', title: 'Implementation' },
      },
      { atMs: 300, type: 'file_write', payload: { path: 'src/example.ts' } },
      { atMs: 400, type: 'command_started', payload: { commandKind: 'test', commandName: 'unit' } },
      { atMs: 500, type: 'test_started', payload: { testKind: 'unit' } },
      { atMs: 600, type: 'test_passed', payload: { testKind: 'unit', durationMs: 100 } },
      {
        atMs: 700,
        type: 'command_finished',
        payload: { commandKind: 'test', exitCode: 0, durationMs: 300 },
      },
      {
        atMs: 800,
        type: 'milestone_completed',
        payload: { milestoneId: 'implementation', title: 'Implementation' },
      },
      { atMs: 900, type: 'session_finished', payload: { reason: 'completed', exitCode: 0 } },
    ],
  },
  'test-failure': {
    name: 'test-failure',
    steps: [
      commonStart,
      { atMs: 100, type: 'planning', payload: { summary: 'plan' } },
      { atMs: 200, type: 'file_write', payload: { path: 'src/example.ts' } },
      { atMs: 300, type: 'test_started', payload: { testKind: 'unit' } },
      {
        atMs: 400,
        type: 'test_failed',
        payload: { testKind: 'unit', failureSummary: 'assertion failed' },
      },
      { atMs: 500, type: 'session_finished', payload: { reason: 'failed', exitCode: 1 } },
    ],
  },
  'blocked-then-resumed': {
    name: 'blocked-then-resumed',
    steps: [
      commonStart,
      { atMs: 100, type: 'blocked', payload: { reason: 'needs user input' } },
      { atMs: 400, type: 'unblocked', payload: { reason: 'user responded' } },
      { atMs: 500, type: 'file_write', payload: { path: 'src/example.ts' } },
      { atMs: 600, type: 'session_finished', payload: { reason: 'completed', exitCode: 0 } },
    ],
  },
  interrupted: {
    name: 'interrupted',
    steps: [
      commonStart,
      { atMs: 100, type: 'planning', payload: { summary: 'plan' } },
      {
        atMs: 200,
        type: 'command_started',
        payload: { commandKind: 'build', commandName: 'build' },
      },
      { atMs: 300, type: 'session_finished', payload: { reason: 'interrupted' } },
    ],
  },
  'low-signal': {
    name: 'low-signal',
    steps: [
      commonStart,
      {
        atMs: 250,
        type: 'agent_message',
        payload: { summary: 'limited signal' },
        confidence: 0.35,
      },
      { atMs: 500, type: 'session_finished', payload: { reason: 'completed' }, confidence: 0.35 },
    ],
  },
};

export function getMockFixture(name: string | undefined): MockFixture {
  const fixtureName = (name ?? 'basic-success') as MockFixtureName;
  const fixture = MOCK_FIXTURES[fixtureName];
  if (fixture === undefined) {
    throw new Error(`Unknown mock fixture: ${name}`);
  }
  return fixture;
}
