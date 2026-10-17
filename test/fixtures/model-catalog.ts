import { modelCatalog, type ModelCatalogProvider } from "../../src/models";
export const rows = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false,
    inputModalities: ["text", "image"], isDefault: true, defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "max" }] },
  { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false,
    inputModalities: ["text", "image"], isDefault: false, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }] },
];
export const fixtureModels: ModelCatalogProvider = async () => ({ models: modelCatalog(rows), fetchedAt: 0 });
export const modelIds = rows.map((row) => row.model);
