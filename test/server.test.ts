import { afterEach, describe, expect, test } from "bun:test";
import type { ProxyConfig } from "../src/config";
import { CodexModel } from "../src/models";
import { createServer } from "../src/server";
import type { CodexRunner } from "../src/types";

const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "test-token",
  defaultModel: CodexModel.Gpt56Terra,
  sandbox: "read-only",
  timeoutMs: 1_000,
};

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => server?.stop());

function start(runner: CodexRunner = async () => "OK") {
  server = createServer({ config, runner });
  return `http://${server.hostname}:${server.port}`;
}

const authHeaders = { authorization: "Bearer test-token", "content-type": "application/json" };

describe("metadata", () => {
  test("reports health and both model catalogs", async () => {
    const base = start();
    const health = await fetch(`${base}/health`).then((response) => response.json());
    const openAi = await fetch(`${base}/v1/models`).then((response) => response.json());
    const ollama = await fetch(`${base}/api/tags`).then((response) => response.json());

    expect(health.ok).toBe(true);
    expect(openAi.data.map((item: { id: string }) => item.id)).toEqual(Object.values(CodexModel));
    expect(ollama.models.map((item: { name: string }) => item.name)).toEqual(Object.values(CodexModel));
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
      body: JSON.stringify({ model: CodexModel.Gpt56Sol, messages: [{ role: "user", content: "hello" }] }),
    }).then((response) => response.json());
    const ollama = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ prompt: "hello" }),
    }).then((response) => response.json());

    expect(openAi.choices[0].message.content).toBe("gpt-5.6-sol|user: hello");
    expect(ollama.response).toBe("gpt-5.6-terra|user: hello");
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
});
