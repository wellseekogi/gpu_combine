import { createServer } from "vite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const coordinator = spawn(process.execPath, ["standalone/server.mjs"], {
  cwd: root,
  env: { ...process.env, RELAY_HOST: "127.0.0.1" },
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});
let vite;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite?.httpServer?.closeAllConnections();
  const frontendClosed = vite?.close().catch((error) => console.error(error.message));
  if (coordinator.pid && coordinator.exitCode === null && coordinator.signalCode === null) {
    await new Promise((resolve) => {
      const fallback = setTimeout(() => coordinator.kill(), 20000);
      coordinator.once("exit", () => { clearTimeout(fallback); resolve(); });
      if (coordinator.connected) coordinator.send("relay:shutdown");
      else coordinator.kill();
    });
  }
  // HMR dependency optimization may still be active. The coordinator has
  // already drained SQLite writes, so bound frontend-only shutdown.
  await Promise.race([frontendClosed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("message", (message) => { if (message === "relay:shutdown") void stop(); });
coordinator.on("error", (error) => { console.error(error.message); void stop(1); });
coordinator.on("exit", (code) => { if (!stopping) void stop(code ?? 1); });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Coordinator did not become ready within 15 seconds.")), 15000);
    const onExit = (code) => { clearTimeout(timeout); reject(new Error(`Coordinator exited during startup (${code}).`)); };
    coordinator.once("exit", onExit);
    coordinator.once("error", (error) => { clearTimeout(timeout); reject(error); });
    coordinator.on("message", (message) => {
      if (message !== "relay:ready") return;
      clearTimeout(timeout);
      coordinator.off("exit", onExit);
      resolve();
    });
  });
  if (!stopping) {
    vite = await createServer({ configFile: fileURLToPath(new URL("../standalone/vite.config.ts", import.meta.url)) });
    await vite.listen();
    vite.printUrls();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}
