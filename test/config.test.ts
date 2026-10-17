import { describe, expect, test } from "bun:test";
import { assertSafeBinding, loadConfig } from "../src/config";

describe("configuration", () => {
  test("loads safe defaults", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.sandbox).toBe("read-only");
  });

  test("requires authentication outside loopback", () => {
    const config = loadConfig({ CODEX_PROXY_HOST: "0.0.0.0" });
    expect(() => assertSafeBinding(config)).toThrow();
    expect(() => assertSafeBinding({ ...config, token: "secret" })).not.toThrow();
  });
});

import { modelCatalog, selectReasoningEffort } from "../src/models";

describe("model catalog and reasoning", () => {
  const cache = { models: [
    { slug: "gpt-5.6-terra", visibility: "list" },
    { slug: "gpt-6-astra", visibility: "list", display_name: "GPT-6 Astra",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }],
      default_reasoning_level: "medium" },
    { slug: "gpt-6.1-sol", visibility: "list", display_name: "GPT-6.1 Sol",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
      default_reasoning_level: "low" },
    { slug: "hidden-model", visibility: "hide" },
  ] };
  test("prefers current models without inventing availability or hidden entries", () => {
    expect(modelCatalog(cache).map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-terra"]);
    expect(modelCatalog({ models: [{ slug: "custom-only", visibility: "list" }] }).map((model) => model.id)).toEqual(["custom-only"]);
    expect(modelCatalog(undefined).map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    expect(modelCatalog(cache, ["custom-model"]).at(-1)?.id).toBe("custom-model");
  });
  test("reports only observed reasoning levels and respects each model default", () => {
    const sol = modelCatalog(cache)[0];
    const astra = modelCatalog(cache)[1];
    expect(sol?.supported_reasoning_efforts).toEqual(["low", "max"]);
    expect(selectReasoningEffort(undefined, sol)).toBe("low");
    expect(selectReasoningEffort(undefined, astra)).toBe("medium");
    expect(selectReasoningEffort("max", sol)).toBe("max");
    expect(() => selectReasoningEffort("ultra", sol)).toThrow("not supported");
    expect(() => selectReasoningEffort("invalid", sol)).toThrow("supported reasoning");
    expect(() => selectReasoningEffort(null, sol)).toThrow();
    expect(selectReasoningEffort(undefined, undefined)).toBeUndefined();
    expect(modelCatalog(undefined)[0]?.supported_reasoning_efforts).toBeUndefined();
  });
  test("keeps explicit proxy model settings", () => {
    expect(loadConfig({ CODEX_PROXY_MODEL: "gpt-6-astra" }).defaultModel).toBe("gpt-6-astra");
    expect(loadConfig({ CODEX_MODEL: "gpt-6-astra" }).defaultModel).toBe("gpt-6-astra");
    expect(loadConfig({ CODEX_PROXY_MODEL: "gpt-6.1-sol", CODEX_MODEL: "gpt-6-astra" }).defaultModel).toBe("gpt-6.1-sol");
  });
});
