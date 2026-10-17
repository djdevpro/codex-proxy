import type { ProxyConfig } from "./config";

export const CORS_HEADERS = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function trustedRequest(request: Request, config: ProxyConfig): boolean {
  // Block DNS rebinding of an unauthenticated loopback service.
  if (LOOPBACK_HOSTS.has(config.host) && !LOOPBACK_HOSTS.has(new URL(request.url).hostname)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser clients still use optional Bearer authentication.
  if (config.allowedOrigins?.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
  } catch { return false; }
}

export function withCors(response: Response, request: Request): Response {
  response.headers.delete("access-control-allow-origin");
  const origin = request.headers.get("origin");
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  return response;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export function failure(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

export function isAuthorized(request: Request, token?: string): boolean {
  return !token || request.headers.get("authorization") === "Bearer " + token;
}
