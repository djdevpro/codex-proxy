import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

setDefaultTimeout(15_000);

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOKEN = "integration-test-token";

interface DummyInvocation {
  provider: string;
  command: string;
  model: string;
  sandbox: string;
  prompt: string;
  images: string[];
  ephemeral: boolean;
  skipGitRepoCheck: boolean;
  json: boolean;
  developerConfig: string;
}

interface StreamChunk {
  message?: { content?: string };
  done?: boolean;
}

interface PublicArtifact {
  id: string;
  type: "image";
  filename: string;
  mime_type: string;
  url: string;
}

let proxy: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let temporaryDirectory: string | undefined;
let baseUrl = "";
let serverStdout = "";
let serverStderr = "";
let stdoutCapture: Promise<void> | undefined;
let stderrCapture: Promise<void> | undefined;

async function reservePort(): Promise<number> {
  const listener = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function capture(stream: ReadableStream<Uint8Array>, append: (value: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    append(decoder.decode(value, { stream: true }));
  }
  append(decoder.decode());
}

function diagnostics(): string {
  return `\n--- proxy stdout ---\n${serverStdout}\n--- proxy stderr ---\n${serverStderr}`;
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proxy?.exitCode !== null) throw new Error(`Proxy exited with code ${proxy?.exitCode}.${diagnostics()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The child process may still be binding its socket.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Proxy did not become ready within 10 seconds.${diagnostics()}`);
}

async function stopProxy(): Promise<void> {
  if (proxy?.exitCode === null) {
    proxy.kill();
    await Promise.race([proxy.exited, Bun.sleep(2_000)]);
    if (proxy.exitCode === null) proxy.kill("SIGKILL");
  }
  await Promise.allSettled([proxy?.exited, stdoutCapture, stderrCapture].filter(Boolean));
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true, maxRetries: 8, retryDelay: 100 });
  }
}

beforeAll(
  async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-proxy-integration-"));
    const extension = process.platform === "win32" ? ".exe" : "";
    const dummyCommand = join(temporaryDirectory, `dummy-codex${extension}`);
    const build = await Bun.build({
      entrypoints: [join(PROJECT_ROOT, "test", "fixtures", "dummy-codex.ts")],
      compile: { outfile: dummyCommand },
      minify: true,
    });
    if (!build.success) throw new Error(`Unable to compile dummy Codex CLI:\n${build.logs.join("\n")}`);

    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    proxy = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CODEX_PROXY_HOST: "127.0.0.1",
        CODEX_PROXY_PORT: String(port),
        CODEX_PROXY_TOKEN: TOKEN,
        CODEX_PROXY_COMMAND: dummyCommand,
        CODEX_PROXY_MODEL: "gpt-5.6-terra",
        CODEX_PROXY_SANDBOX: "read-only",
        CODEX_PROXY_TIMEOUT_MS: "5000",
        CODEX_HOME: join(temporaryDirectory, "codex-home"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    stdoutCapture = capture(proxy.stdout, (value) => {
      serverStdout += value;
    });
    stderrCapture = capture(proxy.stderr, (value) => {
      serverStderr += value;
    });
    await waitUntilReady();
  },
  { timeout: 20_000 },
);

afterAll(stopProxy, { timeout: 10_000 });

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

describe("proxy process with a dummy Codex CLI", () => {
  test("starts a real HTTP server and enforces authentication", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "codex-proxy" });

    const unauthorized = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(unauthorized.status).toBe(401);
  });

  test("runs the dummy CLI through an OpenAI completion", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: "Be exact." },
          { role: "user", content: "first ping" },
          { role: "assistant", content: "first pong" },
          { role: "system", content: "From now on, answer as JSON." },
          { role: "user", content: "integration ping" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const invocation = JSON.parse(body.choices[0]?.message.content ?? "") as DummyInvocation;

    expect(invocation).toEqual({
      provider: "dummy-codex",
      command: "exec",
      model: "gpt-5.6-sol",
      sandbox: "read-only",
      prompt:
        "user: first ping\n\nassistant: first pong\n\nsystem: From now on, answer as JSON.\n\nuser: integration ping",
      images: [],
      ephemeral: true,
      skipGitRepoCheck: true,
      json: true,
      developerConfig: 'developer_instructions="system: Be exact."',
    });
  });

  test("streams dummy CLI output through the Ollama API", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "stream integration" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const rows = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as StreamChunk);
    const content = rows.map((row) => row.message?.content ?? "").join("");
    const invocation = JSON.parse(content) as DummyInvocation;

    expect(invocation.provider).toBe("dummy-codex");
    expect(invocation.model).toBe("gpt-5.6-terra");
    expect(invocation.prompt).toBe("user: stream integration");
    expect(rows.at(-1)?.done).toBe(true);
  });

  test("publishes an image created by the dummy CLI", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ role: "user", content: "create __DUMMY_IMAGE__" }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      message: { content: string };
      artifacts: PublicArtifact[];
    };
    const artifact = body.artifacts[0];

    expect(artifact).toMatchObject({ type: "image", filename: "dummy-image.png", mime_type: "image/png" });
    expect(body.message.content).toContain(artifact?.url ?? "missing artifact URL");

    const image = await fetch(artifact?.url ?? "");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(50);
  });

  test("returns multiple images using the OpenAI Images API schema", async () => {
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "Create two distinct proxy mascots.",
        n: 2,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      created: number;
      data: Array<{ b64_json: string }>;
      x_codex_artifacts: PublicArtifact[];
    };

    expect(body.created).toBeInteger();
    expect(body.data).toHaveLength(2);
    expect(body.x_codex_artifacts).toHaveLength(2);
    for (const image of body.data) expect(Buffer.from(image.b64_json, "base64").byteLength).toBeGreaterThan(50);
  });

  test("supports URL responses and validates the requested image count", async () => {
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Create three icons.", n: 3, response_format: "url" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ url: string }> };
    expect(body.data).toHaveLength(3);
    expect((await fetch(body.data[2]?.url ?? "")).headers.get("content-type")).toBe("image/png");

    const invalid = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Too many", n: 11 }),
    });
    expect(invalid.status).toBe(400);

    const unsupported = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Transparent icon", background: "transparent" }),
    });
    expect(unsupported.status).toBe(501);
  });

  test("maps a failing CLI process to a gateway error", async () => {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "__DUMMY_FAILURE__" }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error).toEqual({ message: "Deterministic dummy Codex failure.", type: "codex_error" });
  });
});
