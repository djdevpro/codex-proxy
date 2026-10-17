import { loadConfig } from "../src/config";
import { createCodexRunner } from "../src/codex";
import { createServer } from "../src/server";

async function main() {
  const config = { ...loadConfig(), host: "127.0.0.1", port: 0, token: undefined };
  const server = createServer({ config, runner: createCodexRunner(config) });
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.defaultModel, reasoning_effort: "max", messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    if (!response.ok) throw new Error(await response.text());
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    if (body.choices[0]?.message.content.trim() !== "OK") throw new Error(`Unexpected response: ${body.choices[0]?.message.content}`);
    const structuredResponse = await fetch(`http://${server.hostname}:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel, reasoning_effort: "max",
        messages: [{ role: "user", content: "Return ok=true." }],
        response_format: { type: "json_schema", json_schema: {
          name: "smoke", strict: true,
          schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false },
        } },
      }),
    });
    if (!structuredResponse.ok) throw new Error(await structuredResponse.text());
    const structured = await structuredResponse.json() as { choices: Array<{ message: { content: string } }> };
    if (JSON.parse(structured.choices[0]!.message.content).ok !== true) throw new Error("Structured JSON smoke test failed.");
    console.log(`CLI smoke tests passed: ${config.defaultModel} + max reasoning + text + strict JSON Schema`);
  } finally {
    server.stop();
  }
}

void main();
