import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Read the account's picker catalog without creating a thread or starting generation. */
export async function listCodexModels(command: string): Promise<unknown[]> {
  const cwd = await mkdtemp(join(tmpdir(), "codex-proxy-models-"));
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drain: Promise<void> | undefined;
  let timedOut = false;
  let stderr = "";
  try {
    child = Bun.spawn([command, "app-server", "--stdio", "--disable", "apps", "--disable", "plugins", "-c", "project_doc_max_bytes=0"], {
      cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const subprocess = child;
    timer = setTimeout(() => { timedOut = true; subprocess.kill(); }, 15_000);
    drain = (async () => { for await (const bytes of subprocess.stderr) stderr = (stderr + new TextDecoder().decode(bytes)).slice(-2000); })();
    const reader = subprocess.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextId = 0;
    const send = (value: unknown) => subprocess.stdin.write(JSON.stringify(value) + "\n");
    const request = async (method: string, params: unknown): Promise<any> => {
      const id = ++nextId;
      send({ id, method, params });
      while (true) {
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(timedOut ? "Codex model discovery timed out." : stderr.trim() || "Codex closed during model discovery.");
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Codex model discovery response is too large.");
          continue;
        }
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== id || message.method) continue;
        if (message.error) throw new Error(String(message.error.message ?? "Codex model discovery failed."));
        return message.result;
      }
    };
    await request("initialize", { clientInfo: { name: "codex_proxy_models", version: "1.0.0" }, capabilities: { experimentalApi: true, optOutNotificationMethods: ["item/reasoning/textDelta"] } });
    send({ method: "initialized", params: {} });
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!result || !Array.isArray(result.data)) throw new Error("Codex returned an invalid model catalog.");
      rows.push(...result.data);
      if (rows.length > 10000) throw new Error("Codex model catalog is too large.");
      cursor = result.nextCursor ?? undefined;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor || seen.has(cursor))) throw new Error("Codex returned an invalid model cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  } finally {
    if (timer) clearTimeout(timer);
    child?.kill();
    await Promise.allSettled([child?.exited, drain]);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
