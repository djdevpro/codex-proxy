import { describe, expect, test } from "bun:test";
import { assertSafeBinding, loadConfig } from "../src/config";
import { createModelCatalogProvider, defaultModel, modelCatalog, selectReasoningEffort } from "../src/models";
import { rows } from "./fixtures/model-catalog";

describe("configuration", () => {
  test("loads safe defaults without inventing an available model", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.sandbox).toBe("read-only");
    expect(config.defaultModel).toBeUndefined();
  });
  test("requires authentication outside loopback", () => {
    const config = loadConfig({ CODEX_PROXY_HOST: "0.0.0.0" });
    expect(() => assertSafeBinding(config)).toThrow();
    expect(() => assertSafeBinding({ ...config, token: "secret" })).not.toThrow();
  });
  test("keeps explicit settings but validates against the live catalog", () => {
    expect(loadConfig({ CODEX_PROXY_MODEL: "future-model" }).defaultModel).toBe("future-model");
    expect(loadConfig({ CODEX_MODEL: "alias" }).defaultModel).toBe("alias");
    expect(loadConfig({ CODEX_PROXY_MODEL: "chosen", CODEX_MODEL: "alias" }).defaultModel).toBe("chosen");
    expect(() => defaultModel(modelCatalog(rows), "missing")).toThrow("not available");
  });
});

describe("live model catalog", () => {
  test("excludes hidden entries, preserves future models and does not invent availability", () => {
    const models = modelCatalog([...rows, { model: "hidden-model", hidden: true }, { model: "future-model", inputModalities: ["text"], isDefault: true }]);
    expect(models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "future-model"]);
    expect(models.at(-1)?.input_modalities).toEqual(["text"]);
    expect(defaultModel(models)).toBe("gpt-6.1-sol");
    expect(defaultModel(models, "future-model")).toBe("future-model");
    expect(defaultModel(modelCatalog([{ model: "new-only" }]))).toBe("new-only");
    expect(modelCatalog([{ model: "older-catalog" }])[0]?.input_modalities).toEqual(["text", "image"]);
    expect(() => modelCatalog([])).toThrow("no available models");
  });
  test("uses only observed reasoning levels, including future values", () => {
    const [sol, astra] = modelCatalog(rows);
    expect(selectReasoningEffort(undefined, sol)).toBe("low");
    expect(selectReasoningEffort(undefined, astra)).toBe("medium");
    expect(selectReasoningEffort("max", sol)).toBe("max");
    expect(() => selectReasoningEffort("ultra", sol)).toThrow("not supported");
    expect(() => selectReasoningEffort(null, sol)).toThrow();
    const [future] = modelCatalog([{ model: "future", supportedReasoningEfforts: [{ reasoningEffort: "adaptive" }], defaultReasoningEffort: "adaptive" }]);
    expect(selectReasoningEffort("adaptive", future)).toBe("adaptive");
  });
  test("refreshes on expiry or request, coalesces queries, never masks failures with stale data", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const provider = createModelCatalogProvider(() => "fixture", { now: () => now, ttlMs: 100,
      discover: async () => { calls++; if (fail) throw new Error("session unavailable"); return [{ model: `model-${calls}` }]; } });
    const first = await Promise.all([provider(), provider()]);
    expect(first[0]).toEqual(first[1]); expect(calls).toBe(1);
    now = 99; expect((await provider()).models[0]?.id).toBe("model-1");
    now = 100; expect((await provider()).models[0]?.id).toBe("model-2");
    expect((await provider(true)).models[0]?.id).toBe("model-3");
    fail = true;
    await expect(provider(true)).rejects.toThrow("session unavailable");
    await expect(provider()).rejects.toThrow("session unavailable");
    fail = false;
    expect((await provider()).models[0]?.id).toBe("model-6");
  });
});
