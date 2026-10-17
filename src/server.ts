import { randomUUID } from "node:crypto";
import { streamingResponse, type Endpoint } from "./streaming";
import { ArtifactStore, type PublicArtifact } from "./artifacts";
import { preparePrompt } from "./codex";
import type { ProxyConfig } from "./config";
import { CORS_HEADERS, failure, isAuthorized, json, trustedRequest, withCors } from "./http";
import { handleImageGeneration } from "./image-api";
import { CODEX_MODELS, isCodexModel, modelMetadata, selectReasoningEffort, type CodexModel } from "./models";
import type { CodexInput, CodexResult, CodexRunner, CompletionRequest, Message } from "./types";
import { structuredOutput, validateJsonOutput } from "./structured-output";
import { VERSION } from "./version";

export interface ServerOptions { config: ProxyConfig; runner: CodexRunner }

function selectModel(value: unknown, fallback: CodexModel): CodexModel | null {
  return value === undefined ? fallback : isCodexModel(value) ? value : null;
}

function requestMessages(body: CompletionRequest): Message[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.prompt === "string" && body.prompt.trim()) return [{ role: "user", content: body.prompt }];
  return [];
}

function modelObject(id: CodexModel) {
  return { ...modelMetadata(id), id, object: "model", created: 0, owned_by: "codex" };
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

function normalizeResult(result: string | CodexResult): CodexResult {
  return typeof result === "string" ? { content: result, artifacts: [] } : result;
}

function artifactMarkdown(artifacts: PublicArtifact[]): string {
  return artifacts.map((artifact) => `![${artifact.filename}](${artifact.url})`).join("\n");
}

function contentWithArtifacts(content: string, artifacts: PublicArtifact[]): string {
  const markdown = artifactMarkdown(artifacts);
  if (!markdown) return content;
  return content ? `${content}\n\n${markdown}` : markdown;
}

async function completion(request: Request, endpoint: Endpoint, config: ProxyConfig, runner: CodexRunner, artifacts: ArtifactStore): Promise<Response> {
  if (!isAuthorized(request, config.token)) return failure("Invalid local proxy token.", 401, "authentication_error");

  let body: CompletionRequest;
  try {
    body = (await request.json()) as CompletionRequest;
  } catch {
    return failure("Request body must be valid JSON.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Request body must be an object.", 400);
  if (body.stream !== undefined && typeof body.stream !== "boolean") return failure("stream must be a boolean.", 400);
  const model = selectModel(body.model, config.defaultModel);
  if (!model) return failure(`Unsupported model. Use one of: ${CODEX_MODELS.join(", ")}.`, 400);

  let reasoningEffort: CodexInput["reasoningEffort"];
  try { reasoningEffort = selectReasoningEffort(body.reasoning_effort, modelMetadata(model)); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 400); }

  const messages = requestMessages(body);
  if (messages.length === 0) return failure(endpoint === "ollama-generate" ? "prompt must be a non-empty string." : "messages must be a non-empty array.", 400);

  let prepared: ReturnType<typeof preparePrompt>;
  try {
    prepared = preparePrompt(messages);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 400);
  }
  let format: ReturnType<typeof structuredOutput>;
  try { format = structuredOutput(body.response_format); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 400); }
  const input: CodexInput = { ...prepared, ...format, model, reasoningEffort, signal: request.signal };
  if (body.stream === true) return streamingResponse(endpoint, input, runner, artifacts, request.url);

  try {
    const result = normalizeResult(await runner(input));
    validateJsonOutput(result.content, input);
    const published = artifacts.publish(request.url, result.artifacts);
    const content = input.outputSchema || input.jsonObject ? result.content : contentWithArtifacts(result.content, published);
    const extension = published.length > 0 ? { artifacts: published } : {};
    if (endpoint === "ollama-chat") return json({ model, message: { role: "assistant", content }, done: true, done_reason: "stop", ...extension });
    if (endpoint === "ollama-generate") return json({ model, response: content, done: true, done_reason: "stop", ...extension });
    return json({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      ...extension,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 502, "codex_error");
  }
}

export function createServer({ config, runner }: ServerOptions) {
  const artifacts = new ArtifactStore();
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (!trustedRequest(request, config)) return failure("This browser origin or Host is not allowed to access the local proxy.", 403, "permission_error");
      return withCors(await route(request), request);
    },
  });

  async function route(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method === "GET" && pathname === "/health") return json({ ok: true, service: "codex-proxy", version: VERSION });
      if (request.method === "GET" && pathname === "/v1/models") return json({ object: "list", default_model: config.defaultModel, data: CODEX_MODELS.map(modelObject) });
      if (request.method === "GET" && pathname.startsWith("/v1/models/")) {
        const model = decodeURIComponent(pathname.slice("/v1/models/".length));
        return isCodexModel(model) ? json(modelObject(model)) : failure("Model not found.", 404, "not_found_error");
      }
      if (request.method === "GET" && pathname === "/api/tags") return json({ models: CODEX_MODELS.map(ollamaModel) });
      if (request.method === "GET" && pathname === "/api/ps") return json({ models: [] });
      if (request.method === "GET" && pathname === "/api/version") return json({ version: VERSION });
      if (request.method === "GET" && pathname.startsWith("/artifacts/")) {
        return (await artifacts.response(pathname)) ?? failure("Artifact not found.", 404, "not_found_error");
      }
      if (request.method === "POST" && pathname === "/api/show") return json({ license: "", modelfile: "", parameters: "", template: "", details: { family: "codex", families: ["codex"] } });
      if (request.method === "POST" && pathname === "/v1/images/generations") return handleImageGeneration(request, config, runner, artifacts);
      if (request.method === "POST" && pathname === "/v1/chat/completions") return completion(request, "openai", config, runner, artifacts);
      if (request.method === "POST" && pathname === "/api/chat") return completion(request, "ollama-chat", config, runner, artifacts);
      if (request.method === "POST" && pathname === "/api/generate") return completion(request, "ollama-generate", config, runner, artifacts);
      return failure("Not found.", 404, "not_found_error");
  }
}
