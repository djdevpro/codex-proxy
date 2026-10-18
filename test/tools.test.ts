import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import type { ProxyConfig } from "../src/config";
import { handleImageGeneration } from "../src/image-api";
import { createServer } from "../src/server";
import type { CodexInput, CodexRunner, GeneratedArtifact } from "../src/types";
import { normalizeSources, webSearchRequested, webSourcesFromItem } from "../src/web-search";
import { fixtureModels } from "./fixtures/model-catalog";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, sandbox: "read-only", timeoutMs: 1000, defaultModel: "gpt-6.1-sol" };
const headers = { "content-type": "application/json" };
let server: ReturnType<typeof createServer> | undefined;
const directories: string[] = [];
afterEach(async () => {
  server?.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});
function start(runner: CodexRunner) {
  server = createServer({ config, runner, models: fixtureModels });
  return `http://${server.hostname}:${server.port}`;
}

describe("web tool contract", () => {
  test("advertises tools and the 32 attachment limit", async () => {
    const base = start(async () => "OK");
    expect((await fetch(base + "/health").then((r) => r.json())).capabilities).toEqual({ web_search: true, image_generation: true });
    expect((await fetch(base + "/v1/models").then((r) => r.json())).capabilities).toMatchObject({ web_search: true, image_generation: true, max_files: 32, max_total_bytes: 10 * 1024 * 1024 });
  });
  test("accepts only the supported explicit opt-in and rejects ambiguous permissions", async () => {
    let received: CodexInput | undefined;
    let calls = 0;
    const base = start(async (input) => { calls++; received = input; return "OK"; });
    const request = (tools?: unknown) => fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ tools, messages: [{ role: "user", content: "hello" }] }) });
    expect(webSearchRequested(undefined)).toBe(false);
    expect(webSearchRequested([])).toBe(false);
    expect((await request()).status).toBe(200);
    expect(received?.webSearch).toBe(false);
    expect((await request([{ type: "web_search" }])).status).toBe(200);
    expect(received?.webSearch).toBe(true);
    for (const tools of [null, {}, true, [{ type: "shell" }], [{ type: "image_generation" }], [{ type: "web_search", unrestricted: true }], [{ type: "web_search" }, { type: "web_search" }]]) {
      expect((await request(tools)).status).toBe(400);
    }
    expect(calls).toBe(2);
  });
  test("extracts URLs only from completed web tool metadata and bounds all output", () => {
    expect(webSourcesFromItem({ type: "agentMessage", text: "https://invented.example", results: [{ url: "https://invented.example" }] })).toEqual([]);
    const actual = webSourcesFromItem({ type: "webSearch", results: [{ results: [
      { url: "https://docs.convex.dev/", title: "  Docs  " }, { url: "https://docs.convex.dev/", title: "Duplicate" },
      { url: "file:///secret" }, { url: "https://user:password@example.com/" }, { url: "turn0search1" },
    ] }], action: { type: "search", url: "https://not-a-result.example/" } });
    expect(actual).toEqual([{ url: "https://docs.convex.dev/", title: "Docs" }]);
    expect(webSourcesFromItem({ type: "webSearch", action: { type: "findInPage", url: "https://docs.convex.dev/database" } })).toEqual([{ url: "https://docs.convex.dev/database", title: "docs.convex.dev" }]);
    const capped = normalizeSources(Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${i}`, title: "a".repeat(600) })));
    expect(capped.length).toBe(40);
    expect(capped[0]!.title.length).toBe(500);
    expect(normalizeSources([{ url: "https://example.com/" + "a".repeat(4000) }])).toEqual([]);
  });
  test("returns verified sources on JSON and the final SSE chunk only when opted in", async () => {
    const source = { url: "https://docs.convex.dev/", title: "Convex" };
    const base = start(async () => ({ content: '{"title":"Convex"}', artifacts: [], sources: [source, { url: "javascript:bad", title: "Unsafe" }] }));
    for (const stream of [false, true]) {
      const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ stream, tools: [{ type: "web_search" }], messages: [{ role: "user", content: "hello" }], response_format: { type: "json_object" } }) });
      const events = stream ? (await response.text()).split("\n\n").filter((row) => row.startsWith("data: {")).map((row) => JSON.parse(row.slice(6))) : [await response.json()];
      expect(events.at(-1).sources).toEqual([source]);
      expect(events.at(-1).choices[0].finish_reason).toBe("stop");
      expect(events.slice(0, -1).some((event) => event.sources)).toBe(false);
    }
    const legacy = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) }).then((r) => r.json());
    expect(legacy.sources).toBeUndefined();
  });
});

async function artifact(size: number): Promise<GeneratedArtifact> {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-tools-test-"));
  directories.push(directory);
  const path = join(directory, "generated.png");
  await Bun.write(path, Buffer.alloc(size));
  return { type: "image", path, filename: "generated.png", mediaType: "image/png" };
}
const imageRequest = (body: object = {}, signal?: AbortSignal) => new Request("http://localhost/v1/images/generations", { method: "POST", headers, body: JSON.stringify({ prompt: "A visual for a slide", ...body }), signal });
const image = (request: Request, runner: CodexRunner) => handleImageGeneration(request, config, runner, new ArtifactStore(), fixtureModels);

describe("image request lifecycle", () => {
  test("preserves selected model and validated reasoning effort", async () => {
    let received: CodexInput | undefined;
    let calls = 0;
    const runner: CodexRunner = async (input) => { calls++; received = input; return { content: "", artifacts: [] }; };
    await image(imageRequest({ model: "gpt-6.1-sol", reasoning_effort: "max" }), runner);
    expect(received?.model).toBe("gpt-6.1-sol");
    expect(received?.reasoningEffort).toBe("max");
    for (const reasoning_effort of [null, "unlimited", 3]) expect((await image(imageRequest({ reasoning_effort }), runner)).status).toBe(400);
    expect(calls).toBe(1);
  });
  test("forwards cancellation and discards a late image result", async () => {
    const controller = new AbortController();
    const generated = await artifact(50);
    const response = await image(imageRequest({}, controller.signal), async (input) => {
      expect(input.signal?.aborted).toBe(false);
      controller.abort(new Error("Image request cancelled"));
      expect(input.signal?.aborted).toBe(true);
      return { content: "", artifacts: [generated] };
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.data).toBeUndefined();
    expect(body.error.message).toContain("cancelled");
    let calls = 0;
    await image(imageRequest({}, controller.signal), async () => { calls++; return ""; });
    expect(calls).toBe(0);
  });
  test("bounds decoded image bytes before encoding or publishing, including multiple variants", async () => {
    const large = await artifact(6 * 1024 * 1024);
    for (const response_format of ["url", "b64_json"]) {
      const response = await image(imageRequest({ n: 2, response_format }), async () => ({ content: "", artifacts: [large, large] }));
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toContain("10 MiB");
    }
    const tooLarge = await artifact(10 * 1024 * 1024 + 1);
    expect((await image(imageRequest(), async () => ({ content: "", artifacts: [tooLarge] }))).status).toBe(502);
    const small = await artifact(100);
    const valid = await image(imageRequest({ n: 2 }), async () => ({ content: "", artifacts: [small, small] }));
    expect(valid.status).toBe(200);
    const body = await valid.json();
    expect(body.data.length).toBe(2);
    expect(Buffer.from(body.data[0].b64_json, "base64").length).toBe(100);
  });
});
