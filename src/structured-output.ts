import type { CodexInput } from "./types";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function structuredOutput(value: unknown): Pick<CodexInput, "outputSchema" | "jsonObject"> {
  if (value === undefined) return {};
  if (!object(value)) throw new Error("response_format must be an object.");
  if (value.type === "text") return {};
  if (value.type === "json_object") return { jsonObject: true };
  if (value.type !== "json_schema" || !object(value.json_schema)) {
    throw new Error("response_format.type must be text, json_object, or json_schema.");
  }
  const format = value.json_schema;
  if (typeof format.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(format.name)) {
    throw new Error("response_format.json_schema.name must contain 1-64 letters, digits, underscores, or hyphens.");
  }
  if (!object(format.schema) || format.schema.type !== "object") {
    throw new Error("response_format.json_schema.schema must be a JSON Schema with type=object.");
  }
  if (format.strict !== undefined && typeof format.strict !== "boolean") {
    throw new Error("response_format.json_schema.strict must be a boolean.");
  }
  return { outputSchema: format.schema };
}

export function validateJsonOutput(content: string, input: CodexInput): void {
  if (!input.outputSchema && !input.jsonObject) return;
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error("Codex did not return valid JSON for the requested response_format."); }
  if (!object(value)) throw new Error("Codex must return a JSON object for the requested response_format.");
}
