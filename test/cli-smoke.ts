import { loadConfig } from "../src/config";
import { createCodexRunner } from "../src/codex";
import { CodexModel } from "../src/models";
import { createServer } from "../src/server";

async function main() {
  const config = { ...loadConfig(), host: "127.0.0.1", port: 0, token: undefined, defaultModel: CodexModel.Gpt56Terra };
  const server = createServer({ config, runner: createCodexRunner(config) });
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CodexModel.Gpt56Terra, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    if (!response.ok) throw new Error(await response.text());
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    if (body.choices[0]?.message.content.trim() !== "OK") throw new Error(`Unexpected response: ${body.choices[0]?.message.content}`);
    console.log("CLI smoke test passed");
  } finally {
    server.stop();
  }
}

void main();
