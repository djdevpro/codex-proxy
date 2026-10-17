import { join } from "node:path";
import { rows } from "./model-catalog";

export async function runDummyAppServer() {
  const send = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
  const threadId = "fixture-thread";
  const turnId = "fixture-turn";
  let thread: Record<string, any> = {};
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const bytes of Bun.stdin.stream()) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      const params = request.params ?? {};
      if (request.method === "initialize") {
        if (!params.capabilities?.optOutNotificationMethods?.includes("item/reasoning/textDelta")) throw new Error("Private reasoning must be excluded.");
        send({ id: request.id, result: {} });
      } else if (request.method === "model/list") {
        if (params.includeHidden !== false) throw new Error("Only visible models should be requested.");
        send({ id: request.id, result: params.cursor === "second-page"
          ? { data: [rows[1]], nextCursor: null }
          : { data: [rows[0], { ...rows[0], model: "hidden-model", hidden: true }], nextCursor: "second-page" } });
      } else if (request.method === "config/read") {
        send({ id: request.id, result: { config: { mcp_servers: { fixture: { enabled: true, tool_timeout_sec: null }, "named.server": { enabled: true } } } } });
      } else if (request.method === "thread/start") {
        if (!params.ephemeral || params.sandbox !== "read-only" || params.modelProvider !== "openai" || params.approvalPolicy !== "never") throw new Error("Unsafe chat setup.");
        if (params.config.mcp_servers.fixture.enabled !== false || params.config.mcp_servers['named.server'].enabled !== false) throw new Error("Inherited MCP must be disabled.");
        if (params.cwd !== process.cwd()) throw new Error("Working directory must be isolated.");
        thread = params;
        send({ id: request.id, result: { thread: { id: threadId } } });
      } else if (request.method === "turn/start") {
        const prompt = params.input.find((part: { type: string }) => part.type === "text")?.text ?? "";
        send({ id: request.id, result: { turn: { id: turnId } } });
        send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
        if (prompt.includes("__DUMMY_HANG__")) {
          const marker = /cancel-\d+/.exec(prompt)?.[0];
          if (marker && process.env.CODEX_HOME) await Bun.write(join(process.env.CODEX_HOME, marker + ".pid"), String(process.pid));
          await Bun.sleep(60_000);
        }
        if (prompt.includes("__DUMMY_DELAY__")) {
          const marker = /progress-\d+/.exec(prompt)?.[0];
          if (!marker || !process.env.CODEX_HOME) throw new Error("Missing progress marker");
          while (!(await Bun.file(join(process.env.CODEX_HOME, marker + ".release")).exists())) await Bun.sleep(10);
        }
        if (prompt.includes("__DUMMY_CRASH__")) process.exit(23);
        if (prompt.includes("__DUMMY_FAILURE__")) {
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "Deterministic dummy Codex failure." } } } });
          continue;
        }
        const notify = (method: string, extra: object) => send({ method, params: { threadId, turnId, ...extra } });
        notify("item/reasoning/textDelta", { itemId: "reason", delta: "private fixture reasoning" });
        notify("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 0, delta: "Public " });
        notify("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 0, delta: "summary." });
        notify("item/completed", { item: { type: "reasoning", id: "reason", summary: ["Public summary."], content: ["private fixture reasoning"] } });
        const commentary = "Public approach update.";
        notify("item/started", { item: { type: "agentMessage", id: "comment", phase: prompt.includes("__DUMMY_DELAYED_PHASE__") ? null : "commentary", text: "" } });
        notify("item/agentMessage/delta", { itemId: "comment", delta: "Public approach " });
        notify("item/agentMessage/delta", { itemId: "comment", delta: "update." });
        notify("item/completed", { item: { type: "agentMessage", id: "comment", phase: "commentary", text: commentary } });
        const text = prompt.includes("__DUMMY_INVALID_JSON__") ? "invalid JSON" : JSON.stringify({
          provider: "dummy-codex", command: "app-server", model: thread.model, prompt,
          reasoningEffort: params.effort, outputSchema: params.outputSchema,
          ...(prompt.includes("__DUMMY_ATTACHMENT__") ? {
            images: params.input.filter((part: { type: string }) => part.type === "localImage").map((part: { path: string }) => part.path),
            imageBytes: await Promise.all(params.input.filter((part: { type: string }) => part.type === "localImage").map(async (part: { path: string }) => (await Bun.file(part.path).arrayBuffer()).byteLength)),
          } : {}),
        });
        notify("item/started", { item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "" } });
        for (let index = 0; index < text.length; index += 20) {
          notify("item/agentMessage/delta", { itemId: "answer", delta: text.slice(index, index + 20) });
          await Bun.sleep(1);
        }
        notify("item/completed", { item: { type: "agentMessage", id: "answer", phase: "final_answer", text } });
        notify("turn/completed", { turn: { id: turnId, status: "completed", error: null } });
      }
    }
  }
}
