# Security

Codex Proxy launches an authenticated local Codex CLI. Treat access to the proxy as access to that Codex session.

## Safe defaults

- The server binds to `127.0.0.1` by default.
- Codex runs in `read-only` sandbox mode by default.
- Non-loopback binding is refused unless `CODEX_PROXY_TOKEN` is set.
- Incoming remote image URLs are rejected; only local `file://` paths are accepted.

Never expose the proxy directly to the public internet. If a container or another machine must connect, use a private network, a strong Bearer token, and an authenticated TLS reverse proxy.

## Reporting a vulnerability

Do not publish credentials, session files, or proof-of-concept requests containing private data in a public issue. Use [GitHub's private vulnerability reporting](https://github.com/djdevpro/codex-proxy/security/advisories/new).
