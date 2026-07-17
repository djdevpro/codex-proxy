import { randomUUID } from "node:crypto";
import { preparePrompt } from "./codex";
import type { ProxyConfig } from "./config";
import { CODEX_MODELS, isCodexModel, type CodexModel } from "./models";
import type { CodexInput, CodexRunner, CompletionRequest, Message } from "./types";
import { VERSION } from "./version";

type Endpoint = "openai" | "ollama-chat" | "ollama-generate";
export interface ServerOptions { config: ProxyConfig; runner: CodexRunner }

const CORS_HEADERS = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function failure(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

function isAuthorized(request: Request, token?: string): boolean {
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}

function selectModel(value: unknown, fallback: CodexModel): CodexModel | null {
  return value === undefined ? fallback : isCodexModel(value) ? value : null;
}

function requestMessages(body: CompletionRequest): Message[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.prompt === "string" && body.prompt.trim()) return [{ role: "user", content: body.prompt }];
  return [];
}

function modelObject(id: CodexModel) {
  return { id, object: "model", created: 0, owned_by: "codex" };
}

function ollamaModel(name: CodexModel) {
  return {
    name,
    model: name,
    modified_at: new Date(0).toISOString(),
    size: 0,
    digest: `codex-cli:${name}`,
    details: { family: "codex", families: ["codex"], format: "remote", parameter_size: "remote", quantization_level: "N/A" },
  };
}

function streamingResponse(endpoint: Endpoint, input: CodexInput, runner: CodexRunner): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const openAi = endpoint === "openai";

  const body = new ReadableStream({
    async start(controller) {
      let emitted = false;
      const send = (chunk: string) => {
        if (!chunk) return;
        emitted = true;
        const payload =
          endpoint === "openai"
            ? { id, object: "chat.completion.chunk", created, model: input.model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }
            : endpoint === "ollama-chat"
              ? { model: input.model, message: { role: "assistant", content: chunk }, done: false }
              : { model: input.model, response: chunk, done: false };
        controller.enqueue(encoder.encode(openAi ? `data: ${JSON.stringify(payload)}\n\n` : `${JSON.stringify(payload)}\n`));
      };

      try {
        const output = await runner(input, send);
        if (!emitted) send(output);
        if (openAi) {
          const completed = { id, object: "chat.completion.chunk", created, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`));
        } else {
          controller.enqueue(encoder.encode(`${JSON.stringify({ model: input.model, done: true, done_reason: "stop" })}\n`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(openAi ? `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\ndata: [DONE]\n\n` : `${JSON.stringify({ error: message })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "cache-control": "no-cache",
      "content-type": openAi ? "text/event-stream" : "application/x-ndjson",
    },
  });
}

async function completion(request: Request, endpoint: Endpoint, config: ProxyConfig, runner: CodexRunner): Promise<Response> {
  if (!isAuthorized(request, config.token)) return failure("Invalid local proxy token.", 401, "authentication_error");

  let body: CompletionRequest;
  try {
    body = (await request.json()) as CompletionRequest;
  } catch {
    return failure("Request body must be valid JSON.", 400);
  }

  const model = selectModel(body.model, config.defaultModel);
  if (!model) return failure(`Unsupported model. Use one of: ${CODEX_MODELS.join(", ")}.`, 400);

  const messages = requestMessages(body);
  if (messages.length === 0) return failure(endpoint === "ollama-generate" ? "prompt must be a non-empty string." : "messages must be a non-empty array.", 400);

  let prepared: ReturnType<typeof preparePrompt>;
  try {
    prepared = preparePrompt(messages);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 400);
  }
  const input = { ...prepared, model };
  if (body.stream === true) return streamingResponse(endpoint, input, runner);

  try {
    const output = await runner(input);
    if (endpoint === "ollama-chat") return json({ model, message: { role: "assistant", content: output }, done: true, done_reason: "stop" });
    if (endpoint === "ollama-generate") return json({ model, response: output, done: true, done_reason: "stop" });
    return json({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 502, "codex_error");
  }
}

export function createServer({ config, runner }: ServerOptions) {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method === "GET" && pathname === "/health") return json({ ok: true, service: "codex-proxy", version: VERSION });
      if (request.method === "GET" && pathname === "/v1/models") return json({ object: "list", data: CODEX_MODELS.map(modelObject) });
      if (request.method === "GET" && pathname.startsWith("/v1/models/")) {
        const model = decodeURIComponent(pathname.slice("/v1/models/".length));
        return isCodexModel(model) ? json(modelObject(model)) : failure("Model not found.", 404, "not_found_error");
      }
      if (request.method === "GET" && pathname === "/api/tags") return json({ models: CODEX_MODELS.map(ollamaModel) });
      if (request.method === "GET" && pathname === "/api/ps") return json({ models: [] });
      if (request.method === "GET" && pathname === "/api/version") return json({ version: VERSION });
      if (request.method === "POST" && pathname === "/api/show") return json({ license: "", modelfile: "", parameters: "", template: "", details: { family: "codex", families: ["codex"] } });
      if (request.method === "POST" && pathname === "/v1/images/generations") {
        return failure("This endpoint is not emulated. Ask Codex to use image generation through chat when that tool is available, or use the official Image API.", 501, "not_supported");
      }
      if (request.method === "POST" && pathname === "/v1/chat/completions") return completion(request, "openai", config, runner);
      if (request.method === "POST" && pathname === "/api/chat") return completion(request, "ollama-chat", config, runner);
      if (request.method === "POST" && pathname === "/api/generate") return completion(request, "ollama-generate", config, runner);
      return failure("Not found.", 404, "not_found_error");
    },
  });
}
