import { describe, expect, test } from "bun:test";
import { attachmentParser, materializeImages } from "../src/attachments";
import { preparePrompt } from "../src/codex";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo4AAAAASUVORK5CYII=";
const file = (text: string) => ({ filename: "document.txt", file_data: `data:text/plain;base64,${Buffer.from(text).toString("base64")}` });

describe("browser attachments", () => {
  test("keeps images as image input and extracts document text as untrusted reference", () => {
    const result = preparePrompt([{ role: "user", content: [{ type: "text", text: "Analyse" }, { type: "image_url", image_url: { url: png } }, { type: "file", file: file("Bonjour été") }] }]);
    expect(result.images).toEqual([png]);
    expect(result.prompt).toContain("Bonjour été");
    expect(result.prompt).toContain("document.txt");
    expect(result.developerInstructions).toContain("reference material");
  });
  test("rejects unsupported, malformed and mislabelled input without fetching URLs", () => {
    for (const url of ["https://example.com/photo.png", "data:image/png;base64,!!!!", "data:image/png;base64,SGVsbG8=", png.replace("image/png", "image/svg+xml")]) {
      expect(() => attachmentParser().image(url)).toThrow();
    }
    expect(() => attachmentParser().textFile({ filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERg==" })).toThrow("Extract PDF");
    expect(() => attachmentParser().textFile({ filename: "bad.txt", file_data: "data:text/plain;base64,//8=" })).toThrow("UTF-8");
    expect(() => attachmentParser().textFile(file("binary\0"))).toThrow("binary");
    expect(() => preparePrompt([{ role: "system", content: [{ type: "file", file: file("rule") }] }])).toThrow("user messages");
  });
  test("bounds count and decoded total size", () => {
    const parser = attachmentParser();
    for (let i=0;i<32;i++) parser.image(png);
    expect(() => parser.image(png)).toThrow("32 attachments");
    const large = file("a".repeat(6 * 1024 * 1024));
    const total = attachmentParser();
    total.textFile(large);
    expect(() => total.textFile(large)).toThrow("combined limit");
    expect(() => attachmentParser().textFile(file("a".repeat(10 * 1024 * 1024 + 1)))).toThrow("10 MiB");
  });
  test("materializes exact image bytes and deletes temporary files", async () => {
    const prepared = await materializeImages([png]);
    const path = prepared.paths[0]!;
    expect(await Bun.file(path).exists()).toBe(true);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")).toBe(png.split(",")[1]!);
    await prepared.cleanup();
    expect(await Bun.file(path).exists()).toBe(false);
    await prepared.cleanup();
  });
});
