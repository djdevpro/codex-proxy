# Contributing

Thanks for helping improve Codex Local Proxy.

## Local setup

```sh
bun install
bun run check
```

Use `bun run dev` while working on the server. `bun run test:integration` starts a separate proxy process with the deterministic dummy Codex executable, so it is safe in CI. Run `bun run smoke` only when you have an authenticated Codex CLI and want to make a live end-to-end request.

## Pull requests

- Keep the proxy local-first and dependency-light.
- Add deterministic tests for protocol or validation changes.
- Do not commit credentials, Codex state, generated release binaries, or `.env` files.
- Document every new endpoint or environment variable in the README.
- Keep OpenAI and Ollama response formats explicit rather than silently accepting unsupported behavior.

## Release checks

Before tagging a release:

```sh
bun run check
bun run smoke
bun run build:release
```

Update the version in `package.json` and `src/version.ts`, then create a matching `vX.Y.Z` tag.
