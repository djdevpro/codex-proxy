import { randomUUID } from "node:crypto";
import { streamingResponse, type Endpoint } from "./streaming";
import { ArtifactStore, type PublicArtifact } from "./artifacts";
import { preparePrompt, resolveCodexCommand } from "./codex";
import { ATTACHMENT_CAPABILITIES } from "./attachments";
import type { ProxyConfig } from "./config";
import { CORS_HEADERS, failure, isAuthorized, json, trustedRequest, withCors } from "./http";
import { handleImageGeneration } from "./image-api";
import { createModelCatalogProvider, defaultModel, selectReasoningEffort, type CodexModel, type ModelCatalog, type ModelCatalogProvider, type ModelMetadata } from "./models";
import type { CodexInput, CodexResult, CodexRunner, CompletionRequest, Message } from "./types";
import { structuredOutput, validateJsonOutput } from "./structured-output";
import { VERSION } from "./version";
import { normalizeSources, TOOL_CAPABILITIES, webSearchRequested } from "./web-search";

export interface ServerOptions { config: ProxyConfig; runner: CodexRunner; models?: ModelCatalogProvider }

function selectModel(value: unknown, fallback: CodexModel, models: ModelMetadata[]): CodexModel | null {
  return value === undefined ? fallback : typeof value === "string" && models.some((model) => model.id === value) ? value : null;
}

function requestMessages(body: CompletionRequest): Message[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.prompt === "string" && body.prompt.trim()) return [{ role: "user", content: body.prompt }];
  return [];
}

function modelObject(model: ModelMetadata) {
  return { ...model, object: "model", created: 0, owned_by: "codex" };
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

async function completion(request: Request, endpoint: Endpoint, config: ProxyConfig, runner: CodexRunner, artifacts: ArtifactStore, catalog: ModelCatalogProvider): Promise<Response> {
  if (!isAuthorized(request, config.token)) return failure("Invalid local proxy token.", 401, "authentication_error");

  let body: CompletionRequest;
  try {
    body = (await request.json()) as CompletionRequest;
  } catch {
    return failure("Request body must be valid JSON.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Request body must be an object.", 400);
  if (body.stream !== undefined && typeof body.stream !== "boolean") return failure("stream must be a boolean.", 400);
  let webSearch: boolean;
  try { webSearch = webSearchRequested(body.tools); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 400); }
  let available: ModelCatalog;
  let fallback: string;
  try { available = await catalog(); fallback = defaultModel(available.models, config.defaultModel); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 503, "model_discovery_error"); }
  const model = selectModel(body.model, fallback, available.models);
  if (!model) return failure(`Unsupported model. Use one of: ${available.models.map((entry) => entry.id).join(", ")}.`, 400);
  const metadata = available.models.find((entry) => entry.id === model)!;

  let reasoningEffort: CodexInput["reasoningEffort"];
  try { reasoningEffort = selectReasoningEffort(body.reasoning_effort, metadata); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 400); }

  const messages = requestMessages(body);
  if (messages.length === 0) return failure(endpoint === "ollama-generate" ? "prompt must be a non-empty string." : "messages must be a non-empty array.", 400);

  let prepared: ReturnType<typeof preparePrompt>;
  try {
    prepared = preparePrompt(messages);
    if (prepared.images.length && !metadata.input_modalities.includes("image")) throw new Error("The selected Codex model does not accept images.");
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 400);
  }
  let format: ReturnType<typeof structuredOutput>;
  try { format = structuredOutput(body.response_format); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error), 400); }
  const input: CodexInput = { ...prepared, ...format, model, reasoningEffort, signal: request.signal, webSearch };
  if (body.stream === true) return streamingResponse(endpoint, input, runner, artifacts, request.url);

  try {
    const result = normalizeResult(await runner(input));
    validateJsonOutput(result.content, input);
    const published = artifacts.publish(request.url, result.artifacts);
    const content = input.outputSchema || input.jsonObject ? result.content : contentWithArtifacts(result.content, published);
    const sources = webSearch ? normalizeSources(result.sources) : [];
    const extension = { ...(published.length ? { artifacts: published } : {}), ...(sources.length ? { sources } : {}) };
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

export function createServer({ config, runner, models }: ServerOptions) {
  const artifacts = new ArtifactStore();
  const catalog = models ?? createModelCatalogProvider(() => resolveCodexCommand(config.codexCommand));
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(request) {
      if (!trustedRequest(request, config)) return failure("This browser origin or Host is not allowed to access the local proxy.", 403, "permission_error");
      try { return withCors(await route(request), request); }
      catch (error) { return withCors(failure(error instanceof Error ? error.message : String(error), 503, "model_discovery_error"), request); }
    },
  });

  async function route(request: Request): Promise<Response> {
      const { pathname, searchParams } = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method === "GET" && pathname === "/health") return json({ ok: true, service: "codex-proxy", version: VERSION, capabilities: TOOL_CAPABILITIES });
      if (request.method === "GET" && pathname === "/v1/models") {
        const found = await catalog(searchParams.get("refresh") === "1");
        const response = json({ object: "list", default_model: defaultModel(found.models, config.defaultModel), data: found.models.map(modelObject), source: "codex-app-server", fetched_at: new Date(found.fetchedAt).toISOString(), capabilities: { ...ATTACHMENT_CAPABILITIES, ...TOOL_CAPABILITIES } });
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (request.method === "GET" && pathname.startsWith("/v1/models/")) {
        const model = decodeURIComponent(pathname.slice("/v1/models/".length));
        const metadata = (await catalog()).models.find((entry) => entry.id === model);
        return metadata ? json(modelObject(metadata)) : failure("Model not found.", 404, "not_found_error");
      }
      if (request.method === "GET" && pathname === "/api/tags") return json({ models: (await catalog()).models.map((model) => ollamaModel(model.id)) });
      if (request.method === "GET" && pathname === "/api/ps") return json({ models: [] });
      if (request.method === "GET" && pathname === "/api/version") return json({ version: VERSION });
      if (request.method === "GET" && pathname.startsWith("/artifacts/")) {
        return (await artifacts.response(pathname)) ?? failure("Artifact not found.", 404, "not_found_error");
      }
      if (request.method === "POST" && pathname === "/api/show") return json({ license: "", modelfile: "", parameters: "", template: "", details: { family: "codex", families: ["codex"] } });
      if (request.method === "POST" && pathname === "/v1/images/generations") return handleImageGeneration(request, config, runner, artifacts, catalog);
      if (request.method === "POST" && pathname === "/v1/chat/completions") return completion(request, "openai", config, runner, artifacts, catalog);
      if (request.method === "POST" && pathname === "/api/chat") return completion(request, "ollama-chat", config, runner, artifacts, catalog);
      if (request.method === "POST" && pathname === "/api/generate") return completion(request, "ollama-generate", config, runner, artifacts, catalog);
      return failure("Not found.", 404, "not_found_error");
  }
}
