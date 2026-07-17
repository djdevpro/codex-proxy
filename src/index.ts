import { assertSafeBinding, loadConfig } from "./config";
import { createCodexRunner } from "./codex";
import { createServer } from "./server";
import { VERSION } from "./version";

const HELP = `Codex Local Proxy v${VERSION}

Usage:
  codex-proxy [--help] [--version]

Environment:
  CODEX_PROXY_HOST        Bind address (default: 127.0.0.1)
  CODEX_PROXY_PORT        Listen port (default: 8787)
  CODEX_PROXY_TOKEN       Optional Bearer token for non-local exposure
  CODEX_PROXY_MODEL       Default model (default: gpt-5.6-terra)
  CODEX_PROXY_COMMAND     Path to the Codex executable
  CODEX_PROXY_SANDBOX     read-only | workspace-write | danger-full-access
  CODEX_PROXY_TIMEOUT_MS  Request timeout in milliseconds
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION);
  process.exit(0);
}

try {
  const config = loadConfig();
  assertSafeBinding(config);
  const server = createServer({ config, runner: createCodexRunner(config) });
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`\n  Codex Local Proxy v${VERSION}\n  Ready on ${url}\n  OpenAI: ${url}/v1\n  Ollama: ${url}\n`);

  const shutdown = () => {
    console.log("Stopping Codex Local Proxy...");
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
