import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_CAPABILITIES = Object.freeze({
  image_data_urls: true, text_files: true,
  image_media_types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  file_media_types: ["text/plain"], max_file_bytes: MAX_BYTES, max_total_bytes: MAX_BYTES, max_files: 32,
});

function dataUrl(value: unknown): { mime: string; bytes: Buffer } {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 200) throw new Error("Attachment exceeds the 10 MiB limit.");
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || !match[2] || match[2].length % 4 !== 0) throw new Error("Attachments must use a valid base64 data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) throw new Error("Invalid attachment base64 data.");
  if (bytes.length > MAX_BYTES) throw new Error("Attachment exceeds the 10 MiB limit.");
  return { mime: match[1]!.toLowerCase(), bytes };
}

function imageData(value: string) {
  const decoded = dataUrl(value);
  const bytes = decoded.bytes;
  const signatures: Record<string, () => boolean> = {
    "image/png": () => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    "image/jpeg": () => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/gif": () => ["GIF87a", "GIF89a"].includes(bytes.subarray(0,6).toString("ascii")),
    "image/webp": () => bytes.subarray(0,4).toString("ascii") === "RIFF" && bytes.subarray(8,12).toString("ascii") === "WEBP",
  };
  if (!signatures[decoded.mime]?.()) throw new Error("Image content must match its PNG, JPEG, WebP or GIF media type.");
  return decoded;
}

export function attachmentParser() {
  let count = 0;
  let total = 0;
  const account = (size: number) => {
    if (++count > ATTACHMENT_CAPABILITIES.max_files) throw new Error("At most 32 attachments are allowed per request.");
    total += size;
    if (total > MAX_BYTES) throw new Error("Attachments exceed the 10 MiB combined limit.");
  };
  return {
    get count() { return count; },
    image(value: string): string {
      if (value.startsWith("file://")) { account(0); return fileURLToPath(value); }
      const { bytes } = imageData(value);
      account(bytes.length);
      return value;
    },
    textFile(value: unknown): string {
      if (!value || typeof value !== "object" || !("filename" in value) || typeof value.filename !== "string" || !("file_data" in value)) throw new Error("Files need filename and file_data.");
      const { mime, bytes } = dataUrl(value.file_data);
      if (mime !== "text/plain") throw new Error("Codex accepts text files here. Extract PDF or Office content to UTF-8 text/plain before sending.");
      account(bytes.length);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("Attached text files must use UTF-8 encoding."); }
      if (text.includes("\0")) throw new Error("Attached text files cannot contain binary data.");
      const name = value.filename.replace(/[\x00-\x1f\x7f]/g, " ").slice(0,255);
      return `Attached document: ${JSON.stringify(name)}\n<attached_document>\n${text}\n</attached_document>`;
    },
  };
}

/** Keep browser image bytes local and remove them after completion, failure or cancellation. */
export async function materializeImages(images: string[]) {
  let directory: string | undefined;
  const cleanup = async () => { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  try {
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      if (!image.startsWith("data:")) { paths.push(image); continue; }
      const { mime, bytes } = imageData(image);
      directory ??= await mkdtemp(join(tmpdir(), "codex-proxy-images-"));
      const path = join(directory, `${index}.${mime.split("/")[1]}`);
      await writeFile(path, bytes, { mode: 0o600 });
      paths.push(path);
    }
    return { paths, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
