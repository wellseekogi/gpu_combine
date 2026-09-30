import {fork, spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function browserUrl(message) {
  const origin = new URL(message.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== message.origin) throw new Error("Invalid coordinator URL.");
  if (message.token && !/^[a-f0-9]{64}$/.test(message.token)) throw new Error("Invalid launch ticket.");
  return origin.origin + "/" + (message.token ? "#setup-token=" + message.token : "");
}
export function openBrowser(url) {
  let command, args;
  if (process.platform === "win32") {
    command = "powershell.exe";
    const script = "Start-Process -FilePath '" + url.replaceAll("'", "''") + "'";
    args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else {
    command = process.platform === "darwin" ? "open" : "xdg-open";
    args = [url];
  }
  return new Promise((accept, reject) => {
    const browser = spawn(command, args, {stdio: "ignore", windowsHide: true});
    browser.once("error", () => reject(new Error("The browser could not be opened.")));
    browser.once("exit", code => code === 0 ? accept() : reject(new Error("The browser could not be opened.")));
  });
}
function runNpm(args, root) {
  return new Promise((accept, reject) => {
    const installer = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: root, stdio: "inherit", windowsHide: true, shell: process.platform === "win32",
    });
    installer.once("error", () => reject(new Error("Node.js tools are missing. Install Node.js LTS from https://nodejs.org/en/download and open START-RELAY.cmd again.")));
    installer.once("exit", code => code === 0 ? accept() : reject(new Error("Automatic preparation failed. Check your internet connection and open START-RELAY.cmd again. See the error above for details.")));
  });
}
export async function ensureBuild(root, run = runNpm) {
  if (existsSync(resolve(root, "standalone-dist/index.html"))) return;
  if (!existsSync(resolve(root, "package.json")) || !existsSync(resolve(root, "package-lock.json"))) {
    throw new Error("Relay program files are missing. Extract the complete Relay download before opening START-RELAY.cmd.");
  }
  console.log("Preparing Relay automatically. This may take a few minutes on first launch.");
  if (!existsSync(resolve(root, "node_modules/vite/package.json"))) await run(["ci", "--include=dev", "--no-audit", "--no-fund"], root);
  await run(["run", "build"], root);
  if (!existsSync(resolve(root, "standalone-dist/index.html"))) throw new Error("Relay preparation did not create the application. Download and extract the complete Relay package again.");
}
export async function launch({root = projectRoot, open = openBrowser, prepare = ensureBuild} = {}) {
  await prepare(root);
  const coordinator = fork(resolve(root, "standalone/server.mjs"), [], {
    cwd: root, env: {...process.env, RELAY_LAUNCH_LOGIN: "1"},
    stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true, execArgv: [],
  });
  let stopping = false;
  const stop = () => {
    if (stopping || coordinator.exitCode !== null) return;
    stopping = true;
    if (coordinator.connected) coordinator.send("relay:shutdown");
    else coordinator.kill();
  };
  const onSigint = () => stop(), onSigterm = () => stop();
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);
  try {
    await new Promise((accept, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error("Relay did not start in time. Close any previous Relay window and try again.")); }, 30000);
      const fail = () => { clearTimeout(timeout); reject(new Error("Relay could not start. If another Relay window is open, use its browser window or close it and try again.")); };
      coordinator.once("error", fail); coordinator.once("exit", fail);
      coordinator.on("message", async message => {
        if (!message || message.type !== "relay:launch-ready") return;
        clearTimeout(timeout); coordinator.off("error", fail); coordinator.off("exit", fail);
        try {
          const url = browserUrl(message);
          await open(url);
          console.log(message.token ? "Relay is ready. Setup opened in your browser automatically." : "Relay is ready. Sign in with your administrator key in the browser.");
        } catch {
          console.error("The browser could not open automatically. Open " + message.origin + " and sign in with your administrator key.");
        }
        accept();
      });
    });
    console.log("Keep this window open while using Relay. Closing it stops this computer's coordinator.");
    return await new Promise(accept => {
      if (coordinator.exitCode !== null) accept(coordinator.exitCode);
      else coordinator.once("exit", code => accept(code ?? 1));
    });
  } finally {
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    stop();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await launch(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}


