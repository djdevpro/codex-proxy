import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "./artifacts";
import { CORS_HEADERS } from "./http";
import { validateJsonOutput } from "./structured-output";
import type { CodexInput, CodexProgressPhase, CodexRunner } from "./types";
import { normalizeSources } from "./web-search";

export type Endpoint = "openai" | "ollama-chat" | "ollama-generate";

export function streamingResponse(endpoint: Endpoint, input: CodexInput, runner: CodexRunner, artifacts: ArtifactStore, requestUrl: string): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const openAi = endpoint === "openai";
  const execution = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    clearInterval(heartbeat);
    input.signal?.removeEventListener("abort", abort);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    controller.close();
  };
  const abort = () => {
    execution.abort(input.signal?.reason);
    close();
  };
  const enqueue = (text: string) => {
    if (!closed) controller.enqueue(encoder.encode(text));
  };
  const sendEvent = (payload: unknown) => enqueue(openAi ? `data: ${JSON.stringify(payload)}\n\n` : `${JSON.stringify(payload)}\n`);
  const chunk = (delta: Record<string, unknown>, extension = {}) => ({
    id, object: "chat.completion.chunk", created, model: input.model,
    choices: [{ index: 0, delta, finish_reason: null }], ...extension,
  });

  async function run() {
    let emitted = false;
    let previousPhase: CodexProgressPhase | undefined;
    const progress = (phase: CodexProgressPhase) => {
      if (phase === previousPhase) return;
      previousPhase = phase;
      const extension = { codex_progress: { phase } };
      sendEvent(openAi ? chunk({}, extension) : {
        model: input.model, done: false, ...extension,
        ...(endpoint === "ollama-chat" ? { message: { role: "assistant", content: "" } } : { response: "" }),
      });
    };
    const send = (content: string) => {
      if (!content) return;
      emitted = true;
      sendEvent(openAi ? chunk({ content }) : endpoint === "ollama-chat"
        ? { model: input.model, message: { role: "assistant", content }, done: false }
        : { model: input.model, response: content, done: false });
    };

    try {
      execution.signal.throwIfAborted();
      // Flush before starting the CLI, including requests with a strict schema.
      progress("starting");
      const summary = (text: string) => {
        if (!text) return;
        sendEvent(openAi ? chunk({ reasoning_summary: text }) : {
          model: input.model, done: false,
          ...(endpoint === "ollama-chat" ? { message: { role: "assistant", content: "", reasoning_summary: text } } : { response: "", reasoning_summary: text }),
        });
      };
      const commentary = (text: string) => {
        if (!text) return;
        sendEvent(openAi ? chunk({ commentary: text }) : {
          model: input.model, done: false,
          ...(endpoint === "ollama-chat" ? { message: { role: "assistant", content: "", commentary: text } } : { response: "", commentary: text }),
        });
      };
      const result = await runner({ ...input, signal: execution.signal }, input.outputSchema || input.jsonObject ? undefined : send, progress, summary, commentary);
      execution.signal.throwIfAborted();
      const normalized = typeof result === "string" ? { content: result, artifacts: [] } : result;
      validateJsonOutput(normalized.content, input);
      if (!emitted) send(normalized.content);
      const published = artifacts.publish(requestUrl, normalized.artifacts);
      if (published.length > 0 && !input.outputSchema && !input.jsonObject) {
        send("\n\n" + published.map((artifact) => `![${artifact.filename}](${artifact.url})`).join("\n"));
      }
      const sources = input.webSearch ? normalizeSources(normalized.sources) : [];
      const extension = { ...(published.length ? { artifacts: published } : {}), ...(sources.length ? { sources } : {}) };
      sendEvent(openAi ? {
        ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...extension,
      } : { model: input.model, done: true, done_reason: "stop", ...extension });
      if (openAi) enqueue("data: [DONE]\n\n");
    } catch (error) {
      if (!execution.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        sendEvent(openAi ? { error: { message, type: "server_error" } } : { error: message });
        if (openAi) enqueue("data: [DONE]\n\n");
      }
    } finally {
      close();
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) { abort(); return; }
      if (openAi) heartbeat = setInterval(() => enqueue(": keepalive\n\n"), 15_000);
      void run();
    },
    cancel(reason) {
      closed = true;
      cleanup();
      execution.abort(reason);
    },
  });
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "content-type": openAi ? "text/event-stream" : "application/x-ndjson",
    },
  });
}
