import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedImagesForThread } from "./artifacts";
import type { ProxyConfig } from "./config";
import type { CodexRunner, Message } from "./types";

function spawnCodexCommand(args: string[]) {
  return Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

export function resolveCodexCommand(configuredCommand?: string): string {
  if (configuredCommand) {
    const resolved = Bun.which(configuredCommand) ?? (existsSync(configuredCommand) ? configuredCommand : null);
    if (resolved) return resolved;
    throw new Error(`CODEX_PROXY_COMMAND does not point to an executable: ${configuredCommand}`);
  }

  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const userHome = homedir();
  const codexHome = process.env.CODEX_HOME ?? join(userHome, ".codex");
  const installDirectory = process.env.CODEX_INSTALL_DIR;
  const fromPath = Bun.which(executable) ?? Bun.which("codex") ?? "";
  const officialInstall = installDirectory ? join(installDirectory, executable) : "";
  const localBin = join(userHome, ".local", "bin", executable);
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      officialInstall,
      fromPath,
      localBin,
      ...(localAppData ? desktopExecutables(join(localAppData, "OpenAI", "Codex", "bin"), executable) : []),
      localAppData ? join(localAppData, "Programs", "OpenAI", "Codex", "bin", executable) : "",
      join(codexHome, "plugins", ".plugin-appserver", executable),
      join(codexHome, ".sandbox-bin", executable),
    );
  } else {
    candidates.push(fromPath, officialInstall, localBin);
  }

  const discovered = candidates.find((candidate) => candidate && existsSync(candidate));
  if (discovered) return discovered;

  throw new Error(
    "Codex CLI was not found. Install it with https://chatgpt.com/codex/install.sh (macOS/Linux) or https://chatgpt.com/codex/install.ps1 (Windows), then run 'codex login'.",
  );
}

function desktopExecutables(directory: string, executable: string): string[] {
  try {
    const direct = join(directory, executable);
    return [direct, ...readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, executable))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)];
  } catch { return []; }
}

function localImagePath(url: string): string {
  if (!url.startsWith("file://")) throw new Error("Only local file:// image URLs are supported.");
  return fileURLToPath(url);
}

export function preparePrompt(messages: Message[]): {
  prompt: string;
  images: string[];
  developerInstructions?: string;
} {
  const images: string[] = [];
  const instructions: string[] = [];
  const conversation: string[] = [];

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object") throw new Error("Every message must be an object.");
    const { role, content } = message;
    if (!["developer", "system", "user", "assistant"].includes(role)) throw new Error("Unsupported message role.");
    if (typeof content !== "string" && !Array.isArray(content)) throw new Error("Message content must be text or an array of content parts.");
    const text =
      typeof content === "string"
        ? content
        : content
        .flatMap((part) => {
          if (part?.type === "text" && typeof part.text === "string") return [part.text];
          if (part?.type !== "image_url" || typeof part.image_url?.url !== "string") throw new Error("Unsupported message content part.");
          images.push(localImagePath(part.image_url.url));
          return [];
        })
        .join("\n");

    if (index === 0 && (role === "system" || role === "developer")) instructions.push(`${role}: ${text}`);
    else conversation.push(`${role}: ${text}`);
  }

  const developerInstructions = instructions.join("\n\n");
  return {
    prompt: conversation.join("\n\n") || "Continue according to the supplied instructions.",
    images,
    ...(developerInstructions ? { developerInstructions } : {}),
  };
}

export function createCodexRunner(config: ProxyConfig): CodexRunner {
  const command = resolveCodexCommand(config.codexCommand);

  return async ({ prompt, images, model, reasoningEffort, developerInstructions, outputSchema, jsonObject, signal }, onOutput, onProgress) => {
    signal?.throwIfAborted();
    let schemaDirectory: string | undefined;
    const args = [
      command,
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--disable", "shell_tool",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--sandbox",
      config.sandbox,
      "--model",
      model,
    ];
    if (reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    const instructions = [developerInstructions, jsonObject ? "Return exactly one valid JSON object. Do not include Markdown fences or any prose outside that object." : ""].filter(Boolean).join("\n\n");
    if (instructions) {
      args.push("--config", `developer_instructions=${JSON.stringify(instructions)}`);
    }
    for (const image of images) args.push("--image", image);
    args.push("--config", 'web_search="disabled"', "--config", "project_doc_max_bytes=0", "--config", "mcp_servers={}");
    if (outputSchema) {
      schemaDirectory = await mkdtemp(join(tmpdir(), "codex-proxy-schema-"));
      const schemaPath = join(schemaDirectory, "output.schema.json");
      try { await writeFile(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 }); }
      catch (error) { await rm(schemaDirectory, { recursive: true, force: true }); throw error; }
      args.push("--output-schema", schemaPath);
    }
    // stdin avoids the Windows command-line limit for long note histories and generated apps.
    args.push("-");

    let child: ReturnType<typeof spawnCodexCommand>;
    try {
      child = spawnCodexCommand(args);
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
      throw new Error(`Unable to start Codex at '${command}': ${error instanceof Error ? error.message : String(error)}`);
    }

    let timedOut = false;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, config.timeoutMs);
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawOutput = "";
    let threadId: string | undefined;
    let finalMessage = "";
    let eventError = "";

    const consumeLine = (line: string) => {
      const value = line.trim();
      if (!value) return;
      try {
        const event = JSON.parse(value) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
          message?: string;
          error?: { message?: string };
        };
        if (event.type === "error" || event.type === "turn.failed") eventError = event.error?.message ?? event.message ?? "Codex turn failed.";
        if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
        // Emit only coarse execution metadata, never the CLI's reasoning text.
        if (event.type === "turn.started" || (event.type?.startsWith("item.") && event.item?.type === "reasoning")) onProgress?.("thinking");
        if (event.type?.startsWith("item.") && event.item?.type === "agent_message") onProgress?.("answering");
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
          finalMessage = event.item.text;
        }
      } catch {
        rawOutput += `${line}\n`;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      consumeLine(buffer);

      const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
      if (timedOut) throw new Error(`Codex request timed out after ${config.timeoutMs}ms.`);
      signal?.throwIfAborted();
      if (eventError) throw new Error(eventError);
      if (exitCode !== 0) throw new Error(stderr.trim() || `Codex exited with code ${exitCode}.`);
      const content = finalMessage || rawOutput.trim();
      if (content) onOutput?.(content);
      return { content, artifacts: await generatedImagesForThread(threadId) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
    }
  };
}
