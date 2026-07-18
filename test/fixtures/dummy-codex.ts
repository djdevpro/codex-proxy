import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args[0] !== "exec") {
  console.error(`Expected the exec command, received: ${args[0] ?? "nothing"}`);
  process.exit(2);
}

const prompt = args.at(-1) ?? "";
if (prompt.includes("__DUMMY_FAILURE__")) {
  console.error("Deterministic dummy Codex failure.");
  process.exit(23);
}

const threadId = randomUUID();
const developerConfig = optionValue("--config") ?? "";
const requestedCount = Number(/__CODEX_PROXY_IMAGE_COUNT_(\d+)__/.exec(developerConfig)?.[1] ?? 0);
const imageCount = requestedCount || (prompt.includes("__DUMMY_IMAGE__") ? 1 : 0);
if (imageCount > 0) {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) {
    console.error("CODEX_HOME is required for the dummy image fixture.");
    process.exit(24);
  }
  const imageDirectory = join(codexHome, "generated_images", threadId);
  await mkdir(imageDirectory, { recursive: true });
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  for (let index = 0; index < imageCount; index += 1) {
    const filename = imageCount === 1 ? "dummy-image.png" : `dummy-image-${index + 1}.png`;
    await Bun.write(join(imageDirectory, filename), onePixelPng);
  }
}

const images: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--image" && args[index + 1]) images.push(args[index + 1]);
}

const invocation = {
  provider: "dummy-codex",
  command: args[0],
  model: optionValue("--model"),
  sandbox: optionValue("--sandbox"),
  prompt,
  images,
  ephemeral: args.includes("--ephemeral"),
  skipGitRepoCheck: args.includes("--skip-git-repo-check"),
  json: args.includes("--json"),
  developerConfig,
};

const output = `${[
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "dummy-message", type: "agent_message", text: JSON.stringify(invocation) } },
  { type: "turn.completed" },
]
  .map((event) => JSON.stringify(event))
  .join("\n")}\n`;

// Split the JSONL stream mid-event to exercise incremental output parsing.
const midpoint = Math.ceil(output.length / 2);
process.stdout.write(output.slice(0, midpoint));
await Bun.sleep(10);
process.stdout.write(output.slice(midpoint));
