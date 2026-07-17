import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "macos-x64": "bun-darwin-x64-baseline",
  "macos-arm64": "bun-darwin-arm64",
} as const;

type TargetName = keyof typeof TARGETS;
const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))?.split("=")[1];
const selected: TargetName[] = process.argv.includes("--all-release")
  ? ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]
  : process.argv.includes("--all-linux")
    ? ["linux-x64", "linux-arm64"]
    : process.argv.includes("--all-macos")
      ? ["macos-x64", "macos-arm64"]
      : [requestedTarget && requestedTarget in TARGETS ? (requestedTarget as TargetName) : "linux-x64"];

await mkdir("dist", { recursive: true });

for (const name of selected) {
  const outfile = join("dist", `codex-proxy-${name}`);
  console.log(`Building ${name}...`);
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    compile: { target: TARGETS[name], outfile },
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`Created ${outfile}`);
}
