<h1 align="center">Codex Proxy</h1>

<p align="center">
  <img src="./assets/banner-v2.png" alt="Codex Proxy — an OpenAI SDK gateway powered by the Codex CLI" width="100%" />
</p>

<p align="center">
  <strong>Plug your Codex CLI into the tools you already love.</strong><br />
  A small, local-first OpenAI SDK gateway powered by your Codex CLI.
</p>

<p align="center">
  <a href="https://github.com/djdevpro/codex-proxy/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/djdevpro/codex-proxy/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://bun.sh"><img alt="Bun 1.3+" src="https://img.shields.io/badge/Bun-1.3%2B-fbf0df?logo=bun&logoColor=14151a" /></a>
  <a href="https://github.com/openai/openai-node"><img alt="OpenAI SDK compatible" src="https://img.shields.io/badge/OpenAI%20SDK-compatible-10a37f?logo=openai&logoColor=white" /></a>
  <img alt="Ollama compatible" src="https://img.shields.io/badge/Ollama-compatible-111111?logo=ollama&logoColor=white" />
  <img alt="Windows, Linux, and macOS" src="https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20macOS-supported-f5a623" />
</p>

---

Codex Proxy turns an authenticated `codex` installation into a loopback API for OpenAI SDKs, Ollama-compatible apps, Open WebUI, automations, and scripts. No database, Docker, API key, or proxy token is required for local use.

> [!IMPORTANT]
> This is a community bridge, not an official OpenAI endpoint. Availability, limits, authentication, and model access still come from your Codex account.

## Highlights

| | Capability |
|---|---|
| ⚡ | One Bun process and one command |
| 🔌 | OpenAI Chat Completions and Ollama-compatible routes |
| 🌊 | SSE and NDJSON streaming |
| 🖼️ | Local vision input and generated image output |
| 🔎 | Automatic Codex discovery on Windows, Linux, and macOS |
| 🛡️ | Loopback-only and read-only sandbox defaults |
| 📦 | Standalone Windows x64, Linux/macOS x64 and ARM64 binaries |

```mermaid
flowchart LR
    A["OpenAI SDK"] --> P["Codex Proxy"]
    B["Compatible clients"] --> P
    P --> C["codex exec"]
    C --> O["Your Codex account"]
```

The proxy translates request and response formats. Codex remains responsible for authentication, model execution, tools, and account limits.

## Quick start

### 1. Install and authenticate Codex

macOS or Linux:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

Windows PowerShell:

```powershell
irm https://chatgpt.com/codex/install.ps1 | iex
codex login
```

### 2. Start the proxy

```sh
bun install
bun run start
```

The service is ready at `http://127.0.0.1:8787`. You can alternatively run a standalone binary from [GitHub Releases](https://github.com/djdevpro/codex-proxy/releases). Codex is discovered from `PATH`, `CODEX_INSTALL_DIR`, official install locations, and versioned Codex Desktop installations on Windows.

If the desktop app works but PowerShell says `codex` is not recognized, run `powershell -NoProfile -File scripts/install-cli-launcher.ps1`. This installs a small launcher in `~/.local/bin` and reuses the desktop CLI and existing login. Undo it with the same script plus `-Uninstall`. Open a new terminal after changing PATH.

### 3. Connect a client

OpenAI SDK:

```sh
npm install openai
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local", // Required by the SDK, ignored by the proxy.
});

const result = await client.chat.completions.create({
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: "Say hello in French." }],
});

console.log(result.choices[0]?.message.content);
```

Ollama-compatible chat:

```sh
curl http://127.0.0.1:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"Say hello in French."}],"stream":false}'
```

| Client setting | Value |
|---|---|
| OpenAI base URL | `http://127.0.0.1:8787/v1` |
| Ollama base URL | `http://127.0.0.1:8787` |
| Default model | `gpt-6.1-sol` when present in the local catalog, then `gpt-6-astra`, then the first available entry |

Docker clients cannot usually reach a host service bound to loopback. If you deliberately bind another interface, set `CODEX_PROXY_TOKEN` and never expose an authenticated Codex session directly to the internet.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Health and version |
| `GET` | `/v1/models` | OpenAI model catalog |
| `POST` | `/v1/chat/completions` | OpenAI chat and SSE |
| `POST` | `/v1/images/generations` | OpenAI-style image generation |
| `GET` | `/api/tags` | Ollama model catalog |
| `POST` | `/api/chat` | Ollama chat and NDJSON |
| `POST` | `/api/generate` | Ollama generation and NDJSON |
| `GET` | `/artifacts/:id/:filename` | Generated image download |

Metadata helpers such as `/v1/models/:id`, `/api/ps`, `/api/version`, and `/api/show` are also available.

### Models and reasoning effort

The proxy prefers GPT-6.1 Sol (`gpt-6.1-sol`) when it appears in the local Codex catalog, then GPT-6 Astra (`gpt-6-astra`). It preserves other visible catalog entries and explicit `CODEX_PROXY_MODEL` or request `model` overrides. It does not copy the default from your personal Codex configuration.

`GET /v1/models` includes `default_model` and, when supplied by the local cache, each model's `display_name`, `supported_reasoning_efforts`, and `default_reasoning_effort`. A cached model is not a guarantee of account access. When the cache is missing, the two current models are offered as fallbacks without invented reasoning metadata.

Set `reasoning_effort` in a chat request to choose a level, including Max:

```json
{
  "model": "gpt-6-astra",
  "reasoning_effort": "max",
  "messages": [{"role": "user", "content": "Explain this problem carefully."}]
}
```

The proxy forwards it to `codex exec --config 'model_reasoning_effort="max"'`. Omitting the field preserves the model default reported by Codex. An invalid level or a level excluded by known model metadata returns HTTP 400 before running Codex. Levels are model-dependent; use the catalog to populate a selector instead of assuming all models support Ultra. You can combine `reasoning_effort` with `response_format`.

### Structured JSON output

Use an OpenAI-compatible JSON Schema request:

```json
{
  "messages": [{"role":"user","content":"Return a French greeting."}],
  "response_format": {
    "type":"json_schema",
    "json_schema": {
      "name":"greeting",
      "strict":true,
      "schema": {
        "type":"object",
        "properties":{"greeting":{"type":"string"}},
        "required":["greeting"],
        "additionalProperties":false
      }
    }
  }
}
```

The proxy passes this schema to Codex `--output-schema` in a temporary file, removes the file after execution, and returns the JSON string in `choices[0].message.content`. The Codex structured-output service enforces supported schema constraints; unsupported schemas return an error. `response_format: {"type":"json_object"}` adds a JSON instruction and verifies that the result parses as an object, without enforcing a schema. `--json` alone is the CLI's JSONL event format, not a final-answer schema.

You can use the same schema directly from PowerShell with the repaired CLI:

~~~powershell
codex exec --output-schema examples/greeting.schema.json --output-last-message result.json "Return a greeting in French."
Get-Content -Raw result.json | ConvertFrom-Json
~~~

Add `--json` only if you also want the separate progress-event stream in JSONL. The final JSON remains in `result.json`.

With an OpenAI SDK client configured as above:

~~~ts
const result = await client.chat.completions.create({
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: "Return a greeting in French." }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "greeting",
      strict: true,
      schema: {
        type: "object",
        properties: { greeting: { type: "string" } },
        required: ["greeting"],
        additionalProperties: false,
      },
    },
  },
});
const value = JSON.parse(result.choices[0]?.message.content ?? "{}");
console.log(value.greeting);
~~~

See the [official non-interactive Codex documentation](https://developers.openai.com/codex/noninteractive/) for the distinction between JSONL events and final-answer schemas.

### System prompts and sliding instructions

Only the first message is promoted to Codex `developer_instructions`, and only when its role is `developer` or legacy `system`. Later instruction messages stay in their original conversational position:

```json
{
  "messages": [
    {"role": "system", "content": "Always answer in French."},
    {"role": "user", "content": "First question"},
    {"role": "assistant", "content": "First answer"},
    {"role": "system", "content": "From now on, answer as JSON."},
    {"role": "user", "content": "Next question"}
  ]
}
```

Here, the first `system` becomes the Codex developer instruction. The sliding `system` remains between the two turns and is handled by Codex as part of the ordered conversation; it is never moved back to the top.

## Images

### Local image input

Use a local `file://` URL in an OpenAI content part. The proxy forwards it to `codex exec --image`:

```json
{
  "model": "gpt-6.1-sol",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Describe this image."},
      {"type": "image_url", "image_url": {"url": "file:///absolute/path/image.png"}}
    ]
  }]
}
```

### Generated images

```sh
curl http://127.0.0.1:8787/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-image-2",
    "prompt":"Two cheerful illustrations containing the word Bonjour.",
    "n":2,
    "size":"1024x1024",
    "quality":"high",
    "response_format":"url"
  }'
```

- `n` accepts 1–10 images.
- The default response uses `{ created, data: [{ b64_json }] }`; `response_format: "url"` returns temporary local URLs.
- Every result is also described in the `x_codex_artifacts` extension and saved by Codex under `~/.codex/generated_images/`.
- `gpt-image-*` is a compatibility alias: the authenticated Codex agent invokes its `imagegen` skill. `size` and `quality` are developer-instruction targets, so they are best effort.
- PNG is supported. Native transparency and partial-image streaming are not.

Image requests made through chat still receive Markdown image links plus an `artifacts` extension.

## Configuration

All settings are optional on loopback.

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_PROXY_HOST` | `127.0.0.1` | Listen address |
| `CODEX_PROXY_PORT` | `8787` | Listen port |
| `CODEX_PROXY_MODEL` | preferred available model | Explicit default model; overrides the `CODEX_MODEL` alias |
| `CODEX_PROXY_MODELS` | Codex cache + current-model fallbacks when the cache is absent | Extra model IDs, comma-separated |
| `CODEX_PROXY_ALLOWED_ORIGINS` | loopback HTTP(S) origins | Extra trusted browser origins, comma-separated |
| `CODEX_PROXY_COMMAND` | auto-detected | Codex executable |
| `CODEX_PROXY_SANDBOX` | `read-only` | Codex sandbox mode |
| `CODEX_PROXY_TIMEOUT_MS` | `600000` | Request timeout |
| `CODEX_PROXY_TOKEN` | unset | Optional on loopback; required elsewhere |

## Development and validation

```sh
bun run dev               # development server
bun run test:unit         # fast in-process tests
bun run test:integration  # real server + executable dummy Codex CLI
bun run check             # typecheck + every deterministic test
bun run smoke             # optional test through your authenticated Codex CLI
bun run build             # binary for the current platform
bun run build:release     # all five release targets
```

## Releases

- **CI** runs typechecking, unit tests, black-box integration tests with a dummy Codex CLI, and a Linux binary smoke test. GitHub needs no Codex credentials.
- **Release** packages Windows x64 plus Linux/macOS x64 and ARM64 binaries with SHA-256 checksums.

```sh
git tag v1.0.0
git push origin v1.0.0
```

You can also run the Release workflow manually for an existing tag. Standalone binaries include Bun, but not Codex or credentials; the target machine still needs an authenticated Codex CLI. See [GitHub Releases](https://github.com/djdevpro/codex-proxy/releases).

## Boundaries

- The Responses API and OpenAI function-call translation are not implemented.
- Each request starts an ephemeral `codex exec`; conversation state belongs to the client. Personal Codex config and project instructions are not loaded. Shell, browser, computer-use and app tools are disabled; the sandbox remains read-only by default.
- Browser requests are limited to loopback HTTP(S) origins unless explicitly allowlisted. Host checks reject DNS rebinding on loopback.
- Chat prompts use stdin to support long conversations on Windows. Cancelling a request stops its CLI process.
- SSE/NDJSON wrap completed CLI output; the CLI runner currently emits the final answer as one chunk, not token-by-token.
- Usage tokens are currently reported as zero because the proxy does not yet map Codex CLI usage events.
- Model availability depends on the authenticated Codex account.

---

<p align="center">
  Built for local workflows that deserve first-class APIs.<br />
  <sub>Keep it on loopback. Keep it simple. Let Codex do the hard part.</sub>
</p>
