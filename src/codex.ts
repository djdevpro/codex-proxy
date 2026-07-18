import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedImagesForThread } from "./artifacts";
import type { ProxyConfig } from "./config";
import type { CodexRunner, Message } from "./types";

function spawnCodexCommand(args: string[]) {
  return Bun.spawn(args, {
    stdin: "ignore",
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
  const fromPath = Bun.which("codex") ?? "";
  const officialInstall = installDirectory ? join(installDirectory, executable) : "";
  const localBin = join(userHome, ".local", "bin", executable);
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      officialInstall,
      localAppData ? join(localAppData, "Programs", "OpenAI", "Codex", "bin", executable) : "",
      join(codexHome, "plugins", ".plugin-appserver", executable),
      join(codexHome, ".sandbox-bin", executable),
      fromPath,
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

  for (const [index, { role, content }] of messages.entries()) {
    const text =
      typeof content === "string"
        ? content
        : content
        .flatMap((part) => {
          if (part.type === "text") return [part.text];
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

  return async ({ prompt, images, model, developerInstructions }, onOutput) => {
    const args = [
      command,
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--sandbox",
      config.sandbox,
      "--model",
      model,
    ];
    if (developerInstructions) {
      args.push("--config", `developer_instructions=${JSON.stringify(developerInstructions)}`);
    }
    for (const image of images) args.push("--image", image);
    args.push(prompt);

    let child: ReturnType<typeof spawnCodexCommand>;
    try {
      child = spawnCodexCommand(args);
    } catch (error) {
      throw new Error(`Unable to start Codex at '${command}': ${error instanceof Error ? error.message : String(error)}`);
    }

    const timeout = setTimeout(() => child.kill(), config.timeoutMs);
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawOutput = "";
    let threadId: string | undefined;
    let finalMessage = "";

    const consumeLine = (line: string) => {
      const value = line.trim();
      if (!value) return;
      try {
        const event = JSON.parse(value) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
        };
        if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
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
      if (exitCode !== 0) throw new Error(stderr.trim() || `Codex exited with code ${exitCode}.`);
      const content = finalMessage || rawOutput.trim();
      if (content) onOutput?.(content);
      return { content, artifacts: await generatedImagesForThread(threadId) };
    } finally {
      clearTimeout(timeout);
    }
  };
}
