import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (!process.env.npm_execpath) {
  throw new Error("Run this installer with npm run install:ci, or run npm ci directly.");
}
const result = spawnSync(process.execPath, [process.env.npm_execpath, "ci", "--include=dev", "--no-audit", "--no-fund"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
