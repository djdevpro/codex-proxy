import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CodexModel = {
  Gpt61Sol: "gpt-6.1-sol",
  Gpt6Astra: "gpt-6-astra",
} as const;

export type CodexModel = string;
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelMetadata {
  id: string;
  display_name?: string;
  supported_reasoning_efforts?: ReasoningEffort[];
  default_reasoning_effort?: ReasoningEffort;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

const validModelId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);

/** Use only visible cached entries, with explicit additions and a fallback for a missing cache. */
export function modelCatalog(cache: unknown, configured: string[] = []): ModelMetadata[] {
  const rows = cache && typeof cache === "object" && "models" in cache && Array.isArray(cache.models) ? cache.models : [];
  const models = new Map<string, ModelMetadata>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.visibility !== "list" || !validModelId(row.slug)) continue;
    const efforts: ReasoningEffort[] = Array.isArray(row.supported_reasoning_levels)
      ? [...new Set<ReasoningEffort>(row.supported_reasoning_levels.flatMap((level: unknown) =>
          level && typeof level === "object" && "effort" in level && isReasoningEffort(level.effort) ? [level.effort] : []))]
      : [];
    models.set(row.slug, {
      id: row.slug,
      ...(typeof row.display_name === "string" ? { display_name: row.display_name } : {}),
      ...(efforts.length ? { supported_reasoning_efforts: efforts } : {}),
      ...(isReasoningEffort(row.default_reasoning_level) && efforts.includes(row.default_reasoning_level)
        ? { default_reasoning_effort: row.default_reasoning_level } : {}),
    });
  }
  if (!models.size) for (const id of Object.values(CodexModel)) models.set(id, { id });
  for (const id of configured.filter(validModelId)) if (!models.has(id)) models.set(id, { id });
  const preferred = [CodexModel.Gpt61Sol, CodexModel.Gpt6Astra] as string[];
  const priority = (id: string) => preferred.includes(id) ? preferred.indexOf(id) : preferred.length;
  return [...models.values()].sort((a, b) => priority(a.id) - priority(b.id));
}

function cachedModels(): unknown {
  try {
    return JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8"));
  } catch { return undefined; }
}

// The cache is a catalog, not proof of account access. Codex checks access when a request runs.
const configuredModels = [process.env.CODEX_PROXY_MODELS, process.env.CODEX_PROXY_MODEL, process.env.CODEX_MODEL]
  .flatMap((value) => value?.split(",").map((model) => model.trim()).filter(Boolean) ?? []);
export const MODEL_CATALOG = Object.freeze(modelCatalog(cachedModels(), configuredModels));
export const CODEX_MODELS = Object.freeze(MODEL_CATALOG.map((model) => model.id));
export const DEFAULT_MODEL = CODEX_MODELS[0]!;

export function isCodexModel(value: unknown): value is CodexModel {
  return typeof value === "string" && CODEX_MODELS.includes(value);
}

export function modelMetadata(id: string): ModelMetadata | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}

export function selectReasoningEffort(value: unknown, model: ModelMetadata | undefined): ReasoningEffort | undefined {
  if (value === undefined) return model?.default_reasoning_effort;
  if (!isReasoningEffort(value)) throw new Error("reasoning_effort must be a supported reasoning level.");
  if (model?.supported_reasoning_efforts && !model.supported_reasoning_efforts.includes(value)) {
    throw new Error("reasoning_effort is not supported by this model. Use one of: " + model.supported_reasoning_efforts.join(", ") + ".");
  }
  return value;
}
