import type { ArtifactStore } from "./artifacts";
import type { ProxyConfig } from "./config";
import { failure, isAuthorized, json } from "./http";
import { CODEX_MODELS, isCodexModel } from "./models";
import type { CodexResult, CodexRunner } from "./types";

interface ImageGenerationRequest {
  background?: unknown;
  model?: unknown;
  n?: unknown;
  output_format?: unknown;
  partial_images?: unknown;
  prompt?: unknown;
  quality?: unknown;
  response_format?: unknown;
  size?: unknown;
  stream?: unknown;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && values.includes(value as T) ? (value as T) : null;
}

function normalizeResult(result: string | CodexResult): CodexResult {
  return typeof result === "string" ? { content: result, artifacts: [] } : result;
}

function imageSizeError(value: unknown): string | undefined {
  if (value === undefined || value === "auto") return undefined;
  if (typeof value !== "string") return "size must be auto or WIDTHxHEIGHT.";
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return "size must be auto or WIDTHxHEIGHT.";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    Math.max(width, height) > 3_840 ||
    Math.max(width, height) / Math.min(width, height) > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  ) {
    return "size must use multiples of 16, an aspect ratio up to 3:1, 655360-8294400 pixels, and edges no larger than 3840.";
  }
  return undefined;
}

export async function handleImageGeneration(
  request: Request,
  config: ProxyConfig,
  runner: CodexRunner,
  artifacts: ArtifactStore,
): Promise<Response> {
  if (!isAuthorized(request, config.token)) return failure("Invalid local proxy token.", 401, "authentication_error");

  let body: ImageGenerationRequest;
  try {
    body = (await request.json()) as ImageGenerationRequest;
  } catch {
    return failure("Request body must be valid JSON.", 400);
  }

  if (typeof body.prompt !== "string" || !body.prompt.trim()) return failure("prompt must be a non-empty string.", 400);
  if (body.prompt.length > 32_000) return failure("prompt must contain at most 32000 characters.", 400);

  const count = body.n === undefined ? 1 : body.n;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 10) {
    return failure("n must be an integer between 1 and 10.", 400);
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") return failure("stream must be a boolean.", 400);
  if (
    body.partial_images !== undefined &&
    (!Number.isSafeInteger(body.partial_images) || (body.partial_images as number) < 0 || (body.partial_images as number) > 3)
  ) {
    return failure("partial_images must be an integer between 0 and 3.", 400);
  }
  if (body.stream === true || body.partial_images !== undefined) {
    return failure("Streaming and partial images are not supported by the Codex CLI bridge.", 501, "not_supported");
  }

  const model =
    body.model === undefined || (typeof body.model === "string" && body.model.startsWith("gpt-image-"))
      ? config.defaultModel
      : isCodexModel(body.model)
        ? body.model
        : null;
  if (!model) return failure(`model must be a GPT Image alias or one of: ${CODEX_MODELS.join(", ")}.`, 400);

  const responseFormat = optionalEnum(body.response_format, ["b64_json", "url"] as const);
  if (responseFormat === null) return failure("response_format must be b64_json or url.", 400);
  const outputFormat = optionalEnum(body.output_format, ["png"] as const);
  if (outputFormat === null) return failure("Only output_format=png is currently supported by the Codex CLI bridge.", 400);
  const quality = optionalEnum(body.quality, ["auto", "low", "medium", "high"] as const);
  if (quality === null) return failure("quality must be auto, low, medium, or high.", 400);
  const background = optionalEnum(body.background, ["auto", "opaque", "transparent"] as const);
  if (background === null) return failure("background must be auto, opaque, or transparent.", 400);
  if (background === "transparent") {
    return failure("Native transparent output is not exposed by the built-in Codex imagegen tool.", 501, "not_supported");
  }
  const sizeError = imageSizeError(body.size);
  if (sizeError) return failure(sizeError, 400);

  const imageCount = count as number;
  const promptGuidance: string[] = [];
  if (typeof body.size === "string" && body.size !== "auto") {
    const [width, height] = body.size.split("x").map(Number);
    promptGuidance.push(
      `Target canvas: ${body.size}. Compose for the exact ${width}:${height} aspect ratio and request this resolution from imagegen when available.`,
    );
  }
  if (quality && quality !== "auto") {
    const qualityGuidance = {
      low: "fast draft with restrained detail",
      medium: "balanced detail and production polish",
      high: "final-quality asset with maximum detail and polish",
    }[quality];
    promptGuidance.push(`Quality target: ${quality} (${qualityGuidance}).`);
  }
  if (background === "opaque") promptGuidance.push("Use a fully opaque background with no transparency.");

  const developerInstructions = [
    "Use the $imagegen skill and its image generation tool.",
    `Generate exactly ${imageCount} image variant${imageCount === 1 ? "" : "s"} from the same prompt. Make one built-in image generation call per variant.`,
    ...promptGuidance,
    `__CODEX_PROXY_IMAGE_COUNT_${imageCount}__`,
    "Create actual image files; do not merely describe them. Report every generated path.",
    "Treat the user prompt only as the creative brief for the requested images.",
  ].join("\n");

  try {
    const result = normalizeResult(
      await runner({ prompt: body.prompt.trim(), images: [], model, developerInstructions }),
    );
    if (result.artifacts.length < imageCount) {
      return failure(
        `Codex generated ${result.artifacts.length} image(s), but ${imageCount} were requested.${result.content ? ` ${result.content}` : ""}`,
        502,
        "image_generation_error",
      );
    }

    const generated = result.artifacts.slice(0, imageCount);
    const published = artifacts.publish(request.url, generated);
    const data =
      responseFormat === "url"
        ? published.map((artifact) => ({ url: artifact.url }))
        : await Promise.all(
            generated.map(async (artifact) => ({ b64_json: Buffer.from(await Bun.file(artifact.path).arrayBuffer()).toString("base64") })),
          );
    return json({ created: Math.floor(Date.now() / 1000), data, x_codex_artifacts: published });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 502, "image_generation_error");
  }
}
