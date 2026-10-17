import { afterEach, describe, expect, test } from "bun:test";
import type { ProxyConfig } from "../src/config";
import { CodexModel } from "../src/models";
import { fixtureModels, modelIds as CODEX_MODELS } from "./fixtures/model-catalog";
import { createServer } from "../src/server";
import type { CodexRunner } from "../src/types";

const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "test-token",
  defaultModel: CodexModel.Gpt61Sol,
  sandbox: "read-only",
  timeoutMs: 1_000,
};

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => server?.stop());

function start(runner: CodexRunner = async () => "OK") {
  server = createServer({ config, runner, models: fixtureModels });
  return `http://${server.hostname}:${server.port}`;
}

const authHeaders = { authorization: "Bearer test-token", "content-type": "application/json" };

describe("metadata", () => {
  test("forwards explicit refresh and reports discovery failures without a substitute list", async () => {
    let refresh: boolean | undefined;
    let failed = false;
    server = createServer({ config: { ...config, defaultModel: undefined }, runner: async () => "unused", models: async (value) => {
      refresh = value;
      if (failed) throw new Error("Codex is unavailable");
      return { fetchedAt: 0, models: [{ id: "new-model", display_name: "New model", is_default: true, input_modalities: ["text"] }] };
    } });
    const base = `http://${server.hostname}:${server.port}`;
    const response = await fetch(base + "/v1/models?refresh=1");
    expect(refresh).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.default_model).toBe("new-model");
    expect(body.data[0].input_modalities).toEqual(["text"]);
    expect(body.capabilities.max_total_bytes).toBe(10 * 1024 * 1024);
    failed = true;
    const failure = await fetch(base + "/v1/models?refresh=1");
    expect(failure.status).toBe(503);
    expect((await failure.json()).error.type).toBe("model_discovery_error");
  });
  test("reports health and both model catalogs", async () => {
    const base = start();
    const health = await fetch(`${base}/health`).then((response) => response.json());
    const openAi = await fetch(`${base}/v1/models`).then((response) => response.json());
    const ollama = await fetch(`${base}/api/tags`).then((response) => response.json());

    expect(health.ok).toBe(true);
    expect(openAi.data.map((item: { id: string }) => item.id)).toEqual(CODEX_MODELS);
    expect(ollama.models.map((item: { name: string }) => item.name)).toEqual(CODEX_MODELS);
  });
});

describe("authentication and validation", () => {
  test("rejects missing tokens, unknown models, and malformed JSON", async () => {
    const base = start();
    const unauthorized = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const unknownModel = await fetch(`${base}/api/generate`, { method: "POST", headers: authHeaders, body: JSON.stringify({ model: "unknown", prompt: "hello" }) });
    const malformed = await fetch(`${base}/api/chat`, { method: "POST", headers: authHeaders, body: "{" });

    expect(unauthorized.status).toBe(401);
    expect(unknownModel.status).toBe(400);
    expect(malformed.status).toBe(400);
  });
});

describe("completions", () => {
  test("returns OpenAI and Ollama-compatible responses", async () => {
    const base = start(async ({ model, prompt }) => `${model}|${prompt}`);
    const openAi = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: CodexModel.Gpt6Astra, messages: [{ role: "user", content: "hello" }] }),
    }).then((response) => response.json());
    const ollama = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ prompt: "hello" }),
    }).then((response) => response.json());

    expect(openAi.choices[0].message.content).toBe("gpt-6-astra|user: hello");
    expect(ollama.response).toBe("gpt-6.1-sol|user: hello");
  });

  test("streams SSE and NDJSON", async () => {
    const runner: CodexRunner = async (_input, onOutput) => {
      onOutput?.("hello ");
      onOutput?.("world");
      return "hello world";
    };
    const base = start(runner);
    const openAi = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
    }).then((response) => response.text());
    const ollama = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
    }).then((response) => response.text());

    expect(openAi).toContain("data: [DONE]");
    expect(openAi).toContain("hello ");
    expect(ollama).toContain('"done":true');
    expect(ollama).toContain("world");
  });

  test("maps only the initial OpenAI instruction to Codex developer instructions", async () => {
    let received: Parameters<CodexRunner>[0] | undefined;
    const base = start(async (input) => {
      received = input;
      return "OK";
    });
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are precise." },
          { role: "developer", content: "Reply in French." },
          { role: "user", content: "Hello" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(received?.prompt).toBe("developer: Reply in French.\n\nuser: Hello");
    expect(received?.developerInstructions).toBe("system: You are precise.");
  });

  test("keeps later system messages in chronological conversation order", async () => {
    let received: Parameters<CodexRunner>[0] | undefined;
    const base = start(async (input) => {
      received = input;
      return "OK";
    });
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        messages: [
          { role: "system", content: "Initial rule." },
          { role: "user", content: "First turn" },
          { role: "assistant", content: "First answer" },
          { role: "system", content: "From now on, answer as JSON." },
          { role: "user", content: "Second turn" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(received?.developerInstructions).toBe("system: Initial rule.");
    expect(received?.prompt).toBe(
      "user: First turn\n\nassistant: First answer\n\nsystem: From now on, answer as JSON.\n\nuser: Second turn",
    );
  });
});

describe("image generation", () => {
  test("translates size, quality, and image count into agent guidance", async () => {
    let prompt = "";
    let developerInstructions = "";
    const base = start(async (input) => {
      prompt = input.prompt;
      developerInstructions = input.developerInstructions ?? "";
      return { content: "", artifacts: [] };
    });
    const response = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "A friendly proxy mascot.",
        n: 2,
        size: "1024x1536",
        quality: "high",
        background: "opaque",
      }),
    });

    expect(response.status).toBe(502);
    expect(prompt).toBe("A friendly proxy mascot.");
    expect(developerInstructions).toContain("Generate exactly 2 image variants");
    expect(developerInstructions).toContain("Target canvas: 1024x1536");
    expect(developerInstructions).toContain("Quality target: high");
    expect(developerInstructions).toContain("fully opaque background");
  });
});


describe("local browser access", () => {
  test("allows Rilby on localhost and rejects unrelated sites before execution", async () => {
    let calls = 0;
    const base = start(async () => { calls++; return "OK"; });
    const allowed = await fetch(base + "/health", { headers: { origin: "http://localhost:3100" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3100");
    const blocked = await fetch(base + "/v1/chat/completions", {
      method: "POST", headers: { ...authHeaders, origin: "https://untrusted.example" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.has("access-control-allow-origin")).toBe(false);
    expect(calls).toBe(0);
    const rebinding = await fetch(base + "/health", { headers: { host: "untrusted.example" } });
    expect(rebinding.status).toBe(403);
  });
});

describe("structured output and malformed requests", () => {
  const messages = [{ role: "user", content: "Return a result." }];
  test("passes JSON Schema to Codex and preserves the JSON content", async () => {
    let received: Parameters<CodexRunner>[0] | undefined;
    const base = start(async (input) => { received = input; return '{"ok":true}'; });
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders,
      body: JSON.stringify({ messages, response_format: { type: "json_schema", json_schema: { name: "result", schema, strict: true } } }),
    });
    expect(response.status).toBe(200);
    expect(received?.outputSchema).toEqual(schema);
    expect((await response.json()).choices[0].message.content).toBe('{"ok":true}');
  });
  test("rejects invalid JSON from Codex instead of pretending success", async () => {
    const base = start(async () => "Not JSON");
    const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders,
      body: JSON.stringify({ messages, response_format: { type: "json_object" } }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain("valid JSON");
  });
  test("validates structured output before emitting streamed content", async () => {
    const base = start(async (_input, output) => { output?.("invalid intermediate"); return '{"ok":true}'; });
    const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders,
      body: JSON.stringify({ messages, stream: true, response_format: { type: "json_object" } }),
    });
    const stream = await response.text();
    expect(stream).toContain("[DONE]");
    expect(stream).not.toContain("invalid intermediate");
    const firstEvent = stream.split("\n\n").filter((event) => event.startsWith("data: {")).map((event) => JSON.parse(event.slice(6))).find((event) => event.choices?.[0]?.delta?.content);
    expect(JSON.parse(firstEvent.choices[0].delta.content)).toEqual({ ok: true });
  });
  test("rejects malformed bodies, message parts and formats without running Codex", async () => {
    let calls = 0;
    const base = start(async () => { calls++; return "OK"; });
    for (const body of [null, [], { messages: [null] }, { messages: [{ role: "user", content: [null] }] },
      { messages, stream: "yes" }, { messages, response_format: { type: "unknown" } },
      { messages, response_format: { type: "json_schema", json_schema: { name: "result", schema: null } } }]) {
      const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });
});

test("accepts explicit reasoning and rejects invalid effort before invoking Codex", async () => {
  let calls = 0;
  let effort: unknown;
  const base = start(async (input) => { calls++; effort = input.reasoningEffort; return "OK"; });
  const body = { model: CodexModel.Gpt61Sol, messages: [{ role: "user", content: "hello" }] };
  const accepted = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders, body: JSON.stringify({ ...body, reasoning_effort: "max" }) });
  expect(accepted.status).toBe(200);
  expect(effort).toBe("max");
  for (const reasoning_effort of ["unlimited", 4, null]) {
    const rejected = await fetch(base + "/v1/chat/completions", { method: "POST", headers: authHeaders, body: JSON.stringify({ ...body, reasoning_effort }) });
    expect(rejected.status).toBe(400);
  }
  expect(calls).toBe(1);
});
