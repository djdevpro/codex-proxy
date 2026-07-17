export const CodexModel = {
  Gpt56Terra: "gpt-5.6-terra",
  Gpt56Sol: "gpt-5.6-sol",
} as const;

export type CodexModel = (typeof CodexModel)[keyof typeof CodexModel];
export const DEFAULT_MODEL = CodexModel.Gpt56Terra;
export const CODEX_MODELS = Object.freeze(Object.values(CodexModel));

export function isCodexModel(value: unknown): value is CodexModel {
  return typeof value === "string" && CODEX_MODELS.includes(value as CodexModel);
}
