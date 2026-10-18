import type { WebSource } from "./types";

export const TOOL_CAPABILITIES = { web_search: true, image_generation: true } as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Tools are opt-in; accepting unknown tool options would silently change permissions. */
export function webSearchRequested(value: unknown): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length > 1 || value.some((tool) =>
    !record(tool) || Object.keys(tool).length !== 1 || tool.type !== "web_search")) {
    throw new Error('tools must be [] or [{"type":"web_search"}].');
  }
  return value.length === 1;
}

export function normalizeSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return [];
  const found = new Map<string, WebSource>();
  for (const candidate of value.slice(0, 1000)) {
    if (!record(candidate) || typeof candidate.url !== "string" || candidate.url.length > 4000) continue;
    try {
      const url = new URL(candidate.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const href = url.href;
      if (href.length > 4000) continue;
      if (!found.has(href)) found.set(href, { url: href, title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim().slice(0, 500) : url.hostname });
      if (found.size === 40) break;
    } catch { /* Invalid or opaque tool references are not public source URLs. */ }
  }
  return [...found.values()];
}

/** Read only tool metadata, never URLs fabricated in an assistant message. */
export function webSourcesFromItem(item: unknown): WebSource[] {
  if (!record(item) || item.type !== "webSearch") return [];
  const candidates: unknown[] = [];
  if (record(item.action) && ["openPage", "findInPage"].includes(String(item.action.type))) candidates.push(item.action);
  const queue: Array<{ value: unknown; depth: number }> = [{ value: item.results, depth: 0 }];
  for (let visited = 0; queue.length && visited < 1000; visited++) {
    const { value, depth } = queue.shift()!;
    if (record(value)) candidates.push(value);
    if (depth < 6 && (record(value) || Array.isArray(value))) {
      for (const nested of Object.values(value).slice(0, 100)) {
        if (queue.length >= 1000) break;
        if (nested && typeof nested === "object") queue.push({ value: nested, depth: depth + 1 });
      }
    }
  }
  return normalizeSources(candidates);
}
