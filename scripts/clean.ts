import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

await mkdir("dist", { recursive: true });
const entries = await readdir("dist");
await Promise.all(
  entries.map((entry) => rm(join("dist", entry), { force: true, recursive: true, maxRetries: 8, retryDelay: 150 })),
);
console.log("Cleaned dist/");
