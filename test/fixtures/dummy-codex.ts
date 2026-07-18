export {};

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

const images: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--image" && args[index + 1]) images.push(args[index + 1]);
}

const invocation = JSON.stringify({
  provider: "dummy-codex",
  command: args[0],
  model: optionValue("--model"),
  sandbox: optionValue("--sandbox"),
  prompt,
  images,
  ephemeral: args.includes("--ephemeral"),
  skipGitRepoCheck: args.includes("--skip-git-repo-check"),
});

// Two writes make the streaming integration test exercise incremental CLI output.
const midpoint = Math.ceil(invocation.length / 2);
process.stdout.write(invocation.slice(0, midpoint));
await Bun.sleep(10);
process.stdout.write(`${invocation.slice(midpoint)}\n`);
