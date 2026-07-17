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
