export const CORS_HEADERS = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export function failure(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

export function isAuthorized(request: Request, token?: string): boolean {
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}
