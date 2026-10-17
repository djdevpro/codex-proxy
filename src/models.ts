import { listCodexModels } from "./model-discovery";

// Preference order only: these names never add entries to the discovered catalog.
export const CodexModel = { Gpt61Sol: "gpt-6.1-sol", Gpt6Astra: "gpt-6-astra" } as const;
export type CodexModel = string;
export type ReasoningEffort = string;
export interface ModelMetadata {
  id: string;
  display_name?: string;
  description?: string;
  supported_reasoning_efforts?: ReasoningEffort[];
  default_reasoning_effort?: ReasoningEffort;
  input_modalities: string[];
  is_default: boolean;
}
export interface ModelCatalog { models: ModelMetadata[]; fetchedAt: number }
export type ModelCatalogProvider = (refresh?: boolean) => Promise<ModelCatalog>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const validModelId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);
export const isReasoningEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export function modelCatalog(rows: unknown[]): ModelMetadata[] {
  const models = new Map<string, ModelMetadata>();
  for (const row of rows) {
    if (!record(row) || row.hidden === true || !validModelId(row.model ?? row.id)) continue;
    const id = (row.model ?? row.id) as string;
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? [...new Set(row.supportedReasoningEfforts.flatMap((entry) => record(entry) && isReasoningEffort(entry.reasoningEffort) ? [entry.reasoningEffort] : []))] : [];
    models.set(id, {
      id,
      ...(typeof row.displayName === "string" ? { display_name: row.displayName } : {}),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(efforts.length ? { supported_reasoning_efforts: efforts } : {}),
      ...(isReasoningEffort(row.defaultReasoningEffort) && efforts.includes(row.defaultReasoningEffort) ? { default_reasoning_effort: row.defaultReasoningEffort } : {}),
      input_modalities: Array.isArray(row.inputModalities) ? row.inputModalities.filter((value): value is string => typeof value === "string") : ["text", "image"],
      is_default: row.isDefault === true,
    });
  }
  if (!models.size) throw new Error("Codex returned no available models. Check the local Codex session.");
  return [...models.values()];
}

export function createModelCatalogProvider(command: () => string, options: { ttlMs?: number; now?: () => number; discover?: (command: string) => Promise<unknown[]> } = {}): ModelCatalogProvider {
  let cached: ModelCatalog | undefined;
  let pending: Promise<ModelCatalog> | undefined;
  const now = options.now ?? Date.now;
  return async (refresh = false) => {
    if (!refresh && cached && now() - cached.fetchedAt < (options.ttlMs ?? 30_000)) return cached;
    if (pending) return pending;
    pending = (async () => {
      const rows = await (options.discover ?? listCodexModels)(command());
      const result = { models: modelCatalog(rows), fetchedAt: now() };
      cached = result;
      return result;
    })();
    try { return await pending; }
    catch (error) { cached = undefined; throw error; }
    finally { pending = undefined; }
  };
}

export function defaultModel(models: ModelMetadata[], configured?: string): string {
  if (configured) {
    if (!models.some((model) => model.id === configured)) throw new Error(`Configured model ${configured} is not available from Codex.`);
    return configured;
  }
  return [CodexModel.Gpt61Sol, CodexModel.Gpt6Astra].find((id) => models.some((model) => model.id === id))
    ?? models.find((model) => model.is_default)?.id ?? models[0]!.id;
}

export function selectReasoningEffort(value: unknown, model: ModelMetadata | undefined): ReasoningEffort | undefined {
  if (value === undefined) return model?.default_reasoning_effort;
  if (!isReasoningEffort(value)) throw new Error("reasoning_effort must be a supported reasoning level.");
  if (!model?.supported_reasoning_efforts?.includes(value)) throw new Error("reasoning_effort is not supported by this model. Use one of: " + (model?.supported_reasoning_efforts?.join(", ") ?? "the model default") + ".");
  return value;
}
