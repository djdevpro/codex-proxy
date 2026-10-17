import { describe, expect, test } from "bun:test";
import { ArtifactStore } from "../src/artifacts";
import { CodexModel } from "../src/models";
import { streamingResponse } from "../src/streaming";
import type { CodexRunner, ProgressHandler } from "../src/types";

const input = { model: CodexModel.Gpt61Sol, images: [], prompt: "test" };
const create = (runner: CodexRunner, structured = false) => streamingResponse("openai", {
  ...input, ...(structured ? { jsonObject: true } : {}),
}, runner, new ArtifactStore(), "http://127.0.0.1:8787/v1/chat/completions");
const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | undefined) => decoder.decode(bytes);

describe("live SSE progress", () => {
  test("starts before completion and forwards genuine phases without content", async () => {
    let complete!: (text: string) => void;
    let report: ProgressHandler | undefined;
    const response = create(async (_input, _output, progress) => {
      report = progress;
      return new Promise<string>((resolve) => { complete = resolve; });
    }, true);
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toContain('"codex_progress":{"phase":"starting"}');
    report?.("thinking");
    const thinking = decode((await reader.read()).value);
    expect(thinking).toContain('"codex_progress":{"phase":"thinking"}');
    expect(thinking).toContain('"delta":{}');
    expect(thinking).not.toContain('"content"');
    report?.("answering");
    expect(decode((await reader.read()).value)).toContain('"phase":"answering"');
    complete('{"ok":true}');
    let remainder = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      remainder += decode(part.value);
    }
    expect(remainder).toContain('"content":"{\\"ok\\":true}"');
    expect(remainder).toContain('"finish_reason":"stop"');
    expect(remainder).toContain("data: [DONE]");
  });

  test("reports post-header failures in SSE without successful completion", async () => {
    const response = create(async () => { throw new Error("CLI failure after connection"); });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"phase":"starting"');
    expect(stream).toContain('"error":{"message":"CLI failure after connection"');
    expect(stream).not.toContain('"finish_reason":"stop"');
    expect(stream).toContain("data: [DONE]");
  });

  test("never streams malformed structured content or marks it successful", async () => {
    const response = create(async (_input, output, progress) => {
      progress?.("thinking");
      output?.("unvalidated draft");
      return "not valid JSON";
    }, true);
    const stream = await response.text();
    expect(stream).toContain("did not return valid JSON");
    expect(stream).not.toContain('"content"');
    expect(stream).not.toContain("unvalidated draft");
    expect(stream).not.toContain('"finish_reason":"stop"');
  });

  test("reader cancellation immediately aborts the runner", async () => {
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
    const response = create(async ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal!.addEventListener("abort", () => {
        aborted();
        reject(signal!.reason);
      }, { once: true });
    }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("user stop");
    await cancelled;
  });

  test("request cancellation aborts the runner without late response chunks", async () => {
    const aborter = new AbortController();
    let seen: AbortSignal | undefined;
    const response = streamingResponse("openai", { ...input, signal: aborter.signal }, async ({ signal }) => {
      seen = signal;
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return "late output";
    }, new ArtifactStore(), "http://127.0.0.1:8787/v1/chat/completions");
    const reader = response.body!.getReader();
    await reader.read();
    aborter.abort();
    expect(seen?.aborted).toBe(true);
    expect((await reader.read()).done).toBe(true);
  });
});
