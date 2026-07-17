import { CODEX_MODELS, DEFAULT_MODEL, isCodexModel, type CodexModel } from "./models";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ProxyConfig {
  host: string;
  port: number;
  token?: string;
  defaultModel: CodexModel;
  codexCommand?: string;
  sandbox: SandboxMode;
  timeoutMs: number;
}

const SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const defaultModel = env.CODEX_PROXY_MODEL ?? DEFAULT_MODEL;
  if (!isCodexModel(defaultModel)) throw new Error(`CODEX_PROXY_MODEL must be one of: ${CODEX_MODELS.join(", ")}.`);

  const sandbox = (env.CODEX_PROXY_SANDBOX ?? "read-only") as SandboxMode;
  if (!SANDBOX_MODES.has(sandbox)) throw new Error("CODEX_PROXY_SANDBOX must be read-only, workspace-write, or danger-full-access.");

  return {
    host: env.CODEX_PROXY_HOST ?? "127.0.0.1",
    port: positiveInteger("CODEX_PROXY_PORT", env.CODEX_PROXY_PORT, 8787),
    token: env.CODEX_PROXY_TOKEN || undefined,
    defaultModel,
    codexCommand: env.CODEX_PROXY_COMMAND || undefined,
    sandbox,
    timeoutMs: positiveInteger("CODEX_PROXY_TIMEOUT_MS", env.CODEX_PROXY_TIMEOUT_MS, 10 * 60 * 1000),
  };
}

export function assertSafeBinding(config: ProxyConfig): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loopbackHosts.has(config.host) && !config.token) {
    throw new Error("CODEX_PROXY_TOKEN is required when CODEX_PROXY_HOST is not a loopback address.");
  }
}
