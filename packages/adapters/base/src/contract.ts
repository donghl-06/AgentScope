import type { AgentEvent, EventSource } from '@agentscope/protocol';

export interface AgentCapabilities {
  readonly structuredEvents: boolean;
  readonly toolCalls: boolean;
  readonly fileEvents: boolean;
  readonly commandEvents: boolean;
  readonly tokenUsage: boolean;
  readonly sessionInfo: boolean;
  readonly milestones: boolean;
}

export interface AdapterDetectContext {
  readonly workspacePath: string;
  readonly executablePath?: string;
  readonly environment: 'windows' | 'wsl' | 'linux' | 'macos' | 'unknown';
}

export interface DetectionResult {
  readonly available: boolean;
  readonly confidence: number;
  readonly version?: string;
  readonly reason?: string;
}

export interface StartAgentRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AttachAgentRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly providerSessionId: string;
}

export type StopReason = 'user_requested' | 'shutdown' | 'timeout' | 'error';
export type Unsubscribe = () => void;
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AttachedSession {
  events(): AsyncIterable<AgentEvent>;
  subscribe(listener: AgentEventListener): Unsubscribe;
  stop(reason?: StopReason): Promise<void>;
  detach(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: string;
  detect(context: AdapterDetectContext): Promise<DetectionResult>;
  capabilities(): AgentCapabilities;
  start?(request: StartAgentRequest): Promise<AttachedSession>;
  attach?(request: AttachAgentRequest): Promise<AttachedSession>;
}

export interface AdapterEventSource extends EventSource {
  readonly adapter: string;
}
