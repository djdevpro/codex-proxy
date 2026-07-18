import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { GeneratedArtifact } from "./types";

export interface PublicArtifact {
  id: string;
  type: "image";
  filename: string;
  mime_type: string;
  url: string;
}

const IMAGE_MEDIA_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

async function imageFiles(directory: string): Promise<GeneratedArtifact[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const artifacts: GeneratedArtifact[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...(await imageFiles(path)));
      continue;
    }
    const mediaType = IMAGE_MEDIA_TYPES.get(extname(entry.name).toLowerCase());
    if (entry.isFile() && mediaType) artifacts.push({ path, filename: entry.name, mediaType, type: "image" });
  }
  return artifacts;
}

export async function generatedImagesForThread(threadId?: string): Promise<GeneratedArtifact[]> {
  if (!threadId || !/^[a-zA-Z0-9_-]+$/.test(threadId)) return [];
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return imageFiles(join(codexHome, "generated_images", threadId));
}

export class ArtifactStore {
  private readonly files = new Map<string, GeneratedArtifact>();

  constructor(private readonly maximumEntries = 200) {}

  publish(requestUrl: string, generated: GeneratedArtifact[]): PublicArtifact[] {
    return generated.map((artifact) => {
      const id = randomUUID();
      this.files.set(id, artifact);
      while (this.files.size > this.maximumEntries) {
        const oldest = this.files.keys().next().value as string | undefined;
        if (!oldest) break;
        this.files.delete(oldest);
      }
      return {
        id,
        type: "image",
        filename: basename(artifact.filename),
        mime_type: artifact.mediaType,
        url: new URL(`/artifacts/${id}/${encodeURIComponent(basename(artifact.filename))}`, requestUrl).toString(),
      };
    });
  }

  async response(pathname: string): Promise<Response | undefined> {
    const id = /^\/artifacts\/([0-9a-f-]{36})(?:\/[^/]*)?$/.exec(pathname)?.[1];
    if (!id) return undefined;
    const artifact = this.files.get(id);
    if (!artifact) return undefined;

    const file = Bun.file(artifact.path);
    if (!(await file.exists())) {
      this.files.delete(id);
      return undefined;
    }
    return new Response(file, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
        "content-type": artifact.mediaType,
      },
    });
  }
}
