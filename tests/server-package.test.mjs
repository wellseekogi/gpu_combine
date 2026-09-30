import test from "node:test";
import assert from "node:assert/strict";
import {execFile, fork} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {packageOptions, packageServer, serverPackage} from "../scripts/package-server.mjs";
import {PROVIDER_FILES, normalizeProviderFile} from "../standalone/provider-archive.mjs";

const root = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
const deployment = [
  "deploy/aws/Dockerfile", "deploy/aws/Dockerfile.dockerignore", "deploy/aws/compose.yaml",
  "deploy/aws/Caddyfile", "deploy/aws/aws.env.example", "deploy/aws/install-docker.sh",
  "deploy/aws/backup.sh", "deploy/aws/configure.mjs", "docs/aws-deployment-ko.md",
];
const runtime = ["package.json", "standalone/server.mjs", "standalone/provider-archive.mjs", "lib/relay/service.mjs"];
const web = ["index.html", "favicon.svg", "provider.py", "gguf_metadata.py",
  "assets/index-fixture.js", "assets/index-fixture.css", "assets/fonts/test.woff2", "assets/icon.webp"];

function archiveEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString("utf8");
    assert.equal(entries.has(name), false, "Duplicate archive entry: " + name);
    assert.equal(name.includes("\\") || name.startsWith("/") || name.split("/").includes(".."), false);
    const start = offset + 30 + length + extra;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), entries.size);
  return entries;
}

async function put(directory, name, data) {
  const path = resolve(directory, name);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, data);
}

async function fixture(t) {
  const container = await mkdtemp(join(tmpdir(), "relay-server-package-"));
  t.after(() => rm(container, {recursive: true, force: true}));
  const directory = resolve(container, "checkout");
  for (const name of [...runtime, ...deployment, ...PROVIDER_FILES, ...web.map(name => "standalone-dist/" + name)]) {
    const source = name === "package.json" ? '{"name":"relay-package-fixture","type":"module"}\n' :
      name === "standalone-dist/index.html" ? '<!doctype html><html><script src="/assets/index-fixture.js"></script></html>\n' :
      name.endsWith(".cmd") ? "@echo off\r\nexit /b 0\r\n" : "// package fixture\r\n";
    await put(directory, name, source);
  }
  return directory;
}

test("server ZIP contains exactly the allowlisted runtime, provider, web build and deployment files", async t => {
  const directory = await fixture(t);
  const result = await packageServer({root: directory});
  assert.equal(result.archivePath, resolve(directory, "outputs/aws-deploy/relay-server.zip"));
  const bytes = await readFile(result.archivePath);
  assert.equal(result.size, bytes.length);
  const entries = archiveEntries(bytes);
  const expected = [...runtime, ...deployment, ...PROVIDER_FILES, ...web.map(name => "standalone-dist/" + name)].sort();
  assert.deepEqual([...entries.keys()], expected);
  assert.deepEqual(result.files, expected);
  for (const name of PROVIDER_FILES)
    assert.deepEqual(entries.get(name), normalizeProviderFile(name, await readFile(resolve(directory, name))));
  assert.equal(entries.get("deploy/aws/install-docker.sh").includes(Buffer.from("\r")), false);
  assert.equal(entries.get("deploy/aws/configure.mjs").includes(Buffer.from("\r")), false);
  assert.deepEqual(await readdir(resolve(directory, "outputs/aws-deploy")), ["relay-server.zip"]);
});

test("adjacent credentials, state, source maps, models and private directories never enter the ZIP", async t => {
  const directory = await fixture(t);
  const marker = "DO_NOT_PACKAGE_PRIVATE_RUNTIME_KEY_6929706";
  for (const name of [".env", ".git/config", ".relay/admin-key.txt", ".relay/state.sqlite",
    "node_modules/module/index.js", "models/private.gguf", "users/alice/key.txt",
    "provider/connection.json", "provider/provider-setup.json", "standalone/admin-key.txt",
    "standalone/.secret.mjs", "standalone/private/module.mjs", "lib/relay/credentials.json",
    "deploy/aws/.env", "deploy/aws/id_rsa", "docs/private.md", "standalone-dist/secrets.js",
    "standalone-dist/.env", "standalone-dist/assets/index-fixture.js.map", "standalone-dist/assets/config.json",
    "standalone-dist/assets/.env.js", "standalone-dist/assets/.relay/admin-key.js",
    "standalone-dist/assets/private/data.js", "standalone-dist/assets/users/alice/key.css",
    "standalone-dist/assets/models/weights.js", "standalone-dist/assets/node_modules/library/index.js"])
    await put(directory, name, marker);
  const {archive} = await serverPackage(directory);
  const entries = archiveEntries(archive);
  assert.equal(archive.includes(Buffer.from(marker)), false);
  assert.equal(entries.size, runtime.length + deployment.length + PROVIDER_FILES.length + web.length);
});

test("directory junctions cannot redirect allowlisted provider files outside the checkout", async t => {
  const directory = await fixture(t);
  const external = resolve(directory, "../external-provider");
  await rename(resolve(directory, "provider"), external);
  await symlink(external, resolve(directory, "provider"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(serverPackage(directory), /Refusing symbolic link.*provider/);
});

test("symlinked web asset directories and checkout roots are rejected", async t => {
  const directory = await fixture(t);
  const external = resolve(directory, "../external-assets");
  await mkdir(external);
  await put(external, "secret.js", "PRIVATE_OUTSIDE_CHECKOUT");
  await symlink(external, resolve(directory, "standalone-dist/assets/external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(serverPackage(directory), /Refusing symbolic link.*external/);
  const alias = resolve(directory, "../checkout-alias");
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(serverPackage(alias), /Refusing symbolic link/);
});

test("symlinked runtime files are rejected before their contents can be read", async t => {
  const directory = await fixture(t);
  const external = resolve(directory, "../external-secret.txt");
  await writeFile(external, "PRIVATE_OUTSIDE_CHECKOUT");
  await unlink(resolve(directory, "standalone/server.mjs"));
  try {
    await symlink(external, resolve(directory, "standalone/server.mjs"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Windows does not allow file symlinks; directory junction coverage remains active");
      return;
    }
    throw error;
  }
  await assert.rejects(serverPackage(directory), /Refusing symbolic link.*server\.mjs/);
});

test("missing web build and empty asset payload fail with a build instruction", async t => {
  const missingIndex = await fixture(t);
  await unlink(resolve(missingIndex, "standalone-dist/index.html"));
  await assert.rejects(serverPackage(missingIndex), /Missing web build.*npm run build/);
  const missingScript = await fixture(t);
  await unlink(resolve(missingScript, "standalone-dist/assets/index-fixture.js"));
  await assert.rejects(serverPackage(missingScript), /Missing built JavaScript.*npm run build/);
});

test("required provider and deployment files cannot silently disappear", async t => {
  for (const name of ["provider/update_launcher.py", "deploy/aws/Caddyfile"]) {
    const directory = await fixture(t);
    await unlink(resolve(directory, name));
    await assert.rejects(serverPackage(directory), {code: "ENOENT"});
  }
});

test("real repository ZIP includes its server modules and boots without source or node_modules", async t => {
  const {archive, files} = await serverPackage(root);
  const entries = archiveEntries(archive);
  assert.deepEqual([...entries.keys()], files);
  for (const directory of ["standalone", "lib/relay"]) {
    for (const name of (await readdir(resolve(root, directory))).filter(name => name.endsWith(".mjs")))
      assert.ok(entries.has(directory + "/" + name), "Missing runtime module: " + name);
  }
  for (const name of [...PROVIDER_FILES, ...deployment]) assert.ok(entries.has(name), "Missing payload: " + name);
  assert.ok(entries.has("standalone-dist/index.html"));
  for (const name of files) {
    assert.equal(/(^|\/)(?:\.relay|\.git|node_modules|\.env|admin-key\.txt|connection\.json|provider-setup\.json)(\/|$)/.test(name), false, name);
    assert.equal(/\.(?:sqlite|db|pem|key|gguf|map)$/.test(name), false, name);
    assert.ok(name === "package.json" || /^standalone\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(name) ||
      /^lib\/relay\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(name) || PROVIDER_FILES.includes(name) ||
      deployment.includes(name) || /^standalone-dist\/(?:index\.html|favicon\.svg|provider\.py|gguf_metadata\.py)$/.test(name) ||
      /^standalone-dist\/assets\/[A-Za-z0-9/._-]+\.(?:m?js|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(name), name);
  }
  const directory = await mkdtemp(join(tmpdir(), "relay-extracted-server-"));
  let child;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(accept => {
        const timer = setTimeout(() => child.kill(), 3000);
        child.once("exit", () => { clearTimeout(timer); accept(); });
        if (child.connected) child.send("relay:shutdown"); else child.kill();
      });
    }
    await rm(directory, {recursive: true, force: true});
  });
  for (const [name, data] of entries) await put(directory, name, data);
  const admin = randomBytes(32).toString("hex");
  child = fork(resolve(directory, "standalone/server.mjs"), [], {
    cwd: directory, windowsHide: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {...process.env, RELAY_ADMIN_TOKEN: admin, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1",
      RELAY_DATA_DIR: resolve(directory, "runtime-data"), RELAY_INFERENCE_CONFIG: "", RELAY_PUBLIC_ORIGIN: "",
      RELAY_SECURE_COOKIE: "0", RELAY_TRUST_PROXY: "0", RELAY_LAUNCH_LOGIN: "1"},
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  const origin = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Extracted server startup timed out: " + diagnostics)), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Extracted server exited (${code}): ${diagnostics}`)); });
    child.on("message", message => {
      if (message?.type === "relay:launch-ready") { clearTimeout(timer); accept(message.origin); }
    });
  });
  const page = await fetch(origin, {signal: AbortSignal.timeout(5000)});
  assert.equal(page.status, 200);
  const html = await page.text();
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, "Packaged index contains the built JavaScript entry");
  const javascript = await fetch(new URL(script, origin), {signal: AbortSignal.timeout(5000)});
  assert.equal(javascript.status, 200);
  assert.ok((await javascript.arrayBuffer()).byteLength > 0);
  const login = await fetch(origin + "/api/login", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: admin}), signal: AbortSignal.timeout(5000)});
  assert.equal(login.status, 200);
  await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const provider = await fetch(origin + "/api/setup/provider.zip", {headers: {Cookie: cookie}, signal: AbortSignal.timeout(5000)});
  assert.equal(provider.status, 200, "Extracted server can supply the full provider installer");
  const providerEntries = archiveEntries(Buffer.from(await provider.arrayBuffer()));
  for (const name of PROVIDER_FILES) assert.ok(providerEntries.has(name), name);

});

test("CLI supports selected root/output directories and rejects malformed options", async t => {
  const directory = await fixture(t);
  const out = resolve(directory, "custom output");
  await execute(process.execPath, [resolve(root, "scripts/package-server.mjs"), "--root", directory, "--out", out], {windowsHide: true});
  assert.deepEqual(await readdir(out), ["relay-server.zip"]);
  assert.ok(archiveEntries(await readFile(resolve(out, "relay-server.zip"))).has("standalone/server.mjs"));
  assert.deepEqual(packageOptions([]), {});
  assert.deepEqual(packageOptions(["--out", "release folder", "--root", "checkout"]), {out: "release folder", root: "checkout"});
  for (const args of [["--out"], ["--root", "--out"], ["--token", "secret"], ["--out", "one", "--out", "two"]])
    assert.throws(() => packageOptions(args), /Usage/);
});
