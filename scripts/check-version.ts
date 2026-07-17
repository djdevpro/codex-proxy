import { VERSION } from "../src/version";

const packageJson = (await Bun.file("package.json").json()) as { version?: string };
const tag = process.argv[2];
const tagVersion = tag?.replace(/^v/, "");

if (packageJson.version !== VERSION) {
  console.error(`Version mismatch: package.json=${packageJson.version ?? "missing"}, src/version.ts=${VERSION}`);
  process.exit(1);
}

if (tagVersion && tagVersion !== VERSION) {
  console.error(`Release tag ${tag} does not match project version ${VERSION}.`);
  process.exit(1);
}

console.log(`Version ${VERSION} is consistent.`);
