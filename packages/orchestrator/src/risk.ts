import type { JsonObject, StoredTask } from '@agentscope/storage';

export const RISK_CATEGORIES = [
  'read',
  'workspace-write',
  'process',
  'network',
  'secret',
  'destructive',
  'remote-side-effect',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskSignal {
  readonly category: RiskCategory;
  readonly level: RiskLevel;
  readonly code: string;
  readonly reason: string;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly categories: readonly RiskCategory[];
  readonly requiresApproval: boolean;
  readonly reasons: readonly string[];
  readonly signals: readonly RiskSignal[];
  readonly actionScope: JsonObject;
}

export interface RiskClassificationOptions {
  readonly platform?: 'win32' | 'linux' | 'darwin' | string;
}

/**
 * Classify a Task before a Worker is allowed to execute it. The classifier is
 * intentionally conservative: unknown executables/actions become HIGH risk,
 * while read-only inspection remains LOW risk.
 */
export function classifyTaskRisk(
  task: Pick<StoredTask, 'title' | 'objective' | 'constraints' | 'verification'>,
  options: RiskClassificationOptions = {},
): RiskAssessment {
  const text = [task.title, task.objective, JSON.stringify(task.constraints)].join('\n');
  const signals: RiskSignal[] = [];
  const add = (signal: RiskSignal): void => {
    if (!signals.some((existing) => existing.code === signal.code)) signals.push(signal);
  };
  const has = (pattern: RegExp): boolean => pattern.test(text);

  if (has(/\b(read|inspect|list|view|analy[sz]e|check|review|查询|读取|检查|查看|分析)\b/iu)) {
    add({
      category: 'read',
      level: 'LOW',
      code: 'read-intent',
      reason: 'The Task describes read-only inspection or analysis.',
    });
  }
  if (has(/\b(write|edit|modify|create|implement|update|fix|生成|修改|创建|实现|修复)\b/iu)) {
    add({
      category: 'workspace-write',
      level: 'MEDIUM',
      code: 'workspace-write-intent',
      reason: 'The Task may write files in the workspace.',
    });
  }
  if (has(/\b(run|execute|command|script|test|build|compile|运行|执行|测试|构建|编译)\b/iu)) {
    add({
      category: 'process',
      level: 'MEDIUM',
      code: 'process-intent',
      reason: 'The Task may start a local process or command.',
    });
  }
  if (
    has(
      /\b(curl|wget|invoke-webrequest|fetch|npm\s+install|pnpm\s+install|pip\s+install|http:\/\/|https:\/\/|download|network|联网|下载)\b/iu,
    )
  ) {
    add({
      category: 'network',
      level: 'HIGH',
      code: 'network-action',
      reason: 'The Task or command can contact an external network.',
    });
  }
  if (has(/\b(api[-_ ]?key|token|secret|password|credential|密钥|令牌|凭据|密码)\b/iu)) {
    add({
      category: 'secret',
      level: 'HIGH',
      code: 'secret-material',
      reason: 'The Task references credentials or secret material.',
    });
  }
  if (
    has(
      /\b(delete|remove|drop|destroy|reset|overwrite|format|rm\s+-rf|删除|移除|销毁|重置|覆盖|格式化)\b/iu,
    )
  ) {
    add({
      category: 'destructive',
      level: 'CRITICAL',
      code: 'destructive-action',
      reason: 'The Task may delete, reset, overwrite, or destroy data.',
    });
  }
  if (has(/\b(push|deploy|publish|release|upload|force\s+push|推送|部署|发布|上线|上传)\b/iu)) {
    add({
      category: 'remote-side-effect',
      level: 'CRITICAL',
      code: 'remote-side-effect',
      reason: 'The Task may change a remote repository or service.',
    });
  }
  classifyVerificationCommands(task.verification, add, options.platform);
  if (signals.length === 0) {
    add({
      category: 'process',
      level: 'HIGH',
      code: 'unknown-action',
      reason: 'No safe action category could be established; defaulting to HIGH risk.',
    });
  }
  const categories = [...new Set(signals.map((signal) => signal.category))];
  const level = signals.reduce<RiskLevel>(
    (highest, signal) => higherRisk(highest, signal.level),
    'LOW',
  );
  return {
    level,
    categories,
    requiresApproval: level === 'HIGH' || level === 'CRITICAL',
    reasons: signals.map((signal) => signal.reason),
    signals,
    actionScope: {
      taskTitle: task.title,
      categories,
      platform: options.platform ?? process.platform,
    },
  };
}

function classifyVerificationCommands(
  verification: JsonObject,
  add: (signal: RiskSignal) => void,
  platform: string | undefined,
): void {
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) continue;
    const record = check as Record<string, unknown>;
    const executable = typeof record.executable === 'string' ? record.executable : '';
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string').join(' ')
      : '';
    const command = `${executable} ${args}`.trim();
    if (command.length === 0) {
      add({
        category: 'process',
        level: 'HIGH',
        code: 'malformed-verification-command',
        reason: 'A verification command is missing an executable.',
      });
      continue;
    }
    if (!isKnownLocalExecutable(executable, platform)) {
      add({
        category: 'process',
        level: 'HIGH',
        code: 'unknown-verification-executable',
        reason: `Verification executable '${executable}' is not in the local allowlist.`,
      });
    }
    if (/\b(push|deploy|publish|upload|curl|wget)\b/iu.test(command)) {
      add({
        category: /\b(push|deploy|publish|upload)\b/iu.test(command)
          ? 'remote-side-effect'
          : 'network',
        level: /\b(push|deploy|publish|upload)\b/iu.test(command) ? 'CRITICAL' : 'HIGH',
        code: 'verification-side-effect',
        reason: 'A verification command contains a network or remote-side-effect operation.',
      });
    }
  }
}

function isKnownLocalExecutable(executable: string, platform: string | undefined): boolean {
  const normalized = executable.toLowerCase().replace(/\.cmd$/u, '');
  const common = new Set([
    'node',
    'pnpm',
    'npm',
    'yarn',
    'bun',
    'git',
    'cargo',
    'go',
    'python',
    'python3',
  ]);
  if (common.has(normalized)) return true;
  if (platform === 'win32' && ['powershell', 'pwsh', 'cmd'].includes(normalized)) return true;
  if (platform !== 'win32' && ['sh', 'bash', 'zsh'].includes(normalized)) return true;
  return false;
}

function higherRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return rank[right] > rank[left] ? right : left;
}
