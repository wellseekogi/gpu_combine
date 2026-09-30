import test, {after} from "node:test";
import assert from "node:assert/strict";
import {fork, spawn} from "node:child_process";
import http from "node:http";
import {mkdtemp, mkdir, rm, writeFile, readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {randomBytes} from "node:crypto";
import {createLaunchTicket, directLaunchRequest, validatedPublicOrigin} from "../standalone/launch-auth.mjs";
import {browserUrl, ensureBuild} from "../scripts/launch.mjs";
import {PROVIDER_FILES, PROVIDER_MANIFEST, PROVIDER_SERVICE_CONFIG, providerFileData, providerPackage} from "../standalone/provider-archive.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "work"), {recursive: true});
const directories = [];
const temp = async () => {
  const directory = await mkdtemp(resolve(root, "work/launcher-qa-"));
  directories.push(directory);
  return directory;
};
after(() => Promise.all(directories.map(directory => rm(directory, {recursive: true, force: true, maxRetries: 5}))));
async function boot(options = {}) {
  const admin = randomBytes(32).toString("hex"), directory = await temp();
  const child = fork(resolve(root, "standalone/server.mjs"), [], {cwd: root, env: {
    ...process.env, RELAY_ADMIN_TOKEN: admin, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_SECURE_COOKIE: "0",
    RELAY_PUBLIC_ORIGIN: "", RELAY_LAUNCH_LOGIN: "1", RELAY_DATA_DIR: directory, ...options,
  }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true});
  let output = "", origin, info, ready = false;
  const context = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Startup timed out: " + output)); }, 10000);
    const check = () => { if (origin && ready) { clearTimeout(timeout); accept({child, admin, origin, info, logs: () => output}); } };
    child.stdout.on("data", data => { output += data; const match = output.match(/Relay ready at (\S+)/); if (match) origin = match[1]; check(); });
    child.stderr.on("data", data => { output += data; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { if (!ready) { clearTimeout(timeout); reject(new Error("Startup exited: " + code + ": " + output)); } });
    child.on("message", message => { if (message?.type === "relay:launch-ready") info = message; if (message === "relay:ready") ready = true; check(); });
  });
  // A public origin changes the advertised URL; connect to the actual listener for test traffic.
  if (context.info) context.portOrigin = context.info.origin;
  context.close = () => new Promise(accept => {
    if (child.exitCode !== null) { accept(); return; }
    const timeout = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(timeout); accept(); }); child.send("relay:shutdown");
  });
  return context;
}
function request(base, path, {body, headers = {}} = {}) {
  return new Promise((accept, reject) => {
    const req = http.request(new URL(path, base), {method: body ? "POST" : "GET", headers: {...headers, ...(body ? {"Content-Type": "application/json"} : {})}}, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => accept({status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), json: () => JSON.parse(Buffer.concat(chunks))}));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
function archiveEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    const start = offset + 30 + length + extra; entries.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  return entries;
}

test("launch ticket expires after two minutes and cannot be reused", () => {
  let now = 0; const ticket = createLaunchTicket({now: () => now});
  assert.match(ticket.token, /^[a-f0-9]{64}$/);
  assert.equal(ticket.consume("incorrect"), false);
  now = 119999; assert.equal(ticket.consume(ticket.token), true); assert.equal(ticket.consume(ticket.token), false);
  const expired = createLaunchTicket({now: () => now}); now += 120000; assert.equal(expired.consume(expired.token), false);
});
test("launch requests require exact loopback origin and reject proxies", () => {
  const origin = "http://127.0.0.1:8788";
  const req = headers => new Request(origin + "/api/launch-login", {headers});
  assert.equal(directLaunchRequest(req({}), "192.168.1.3", origin), false);
  assert.equal(directLaunchRequest(req({Origin: "https://evil.example"}), "127.0.0.1", origin), false);
  for (const name of ["Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Via"]) assert.equal(directLaunchRequest(req({[name]: "proxy"}), "127.0.0.1", origin), false);
  assert.equal(directLaunchRequest(new Request("http://evil.example/api/launch-login"), "127.0.0.1", origin), false);
});
test("public origin rejects insecure remote addresses and URL credentials", () => {
  assert.equal(validatedPublicOrigin("https://relay.example/"), "https://relay.example");
  assert.equal(validatedPublicOrigin("http://localhost:8788"), "http://localhost:8788");
  for (const url of ["http://relay.example", "https://user:secret@relay.example", "https://relay.example/path", "https://relay.example/?token=secret", "javascript:alert(1)"]) assert.throws(() => validatedPublicOrigin(url));
});
test("first launch prepares dependencies and build automatically", async () => {
  const directory = await temp(), calls = [];
  await assert.rejects(ensureBuild(directory), /complete Relay download/);
  await writeFile(resolve(directory, "package.json"), "{}"); await writeFile(resolve(directory, "package-lock.json"), "{}");
  await ensureBuild(directory, async args => { calls.push(args); if (args[0] === "run") { await mkdir(resolve(directory, "standalone-dist")); await writeFile(resolve(directory, "standalone-dist/index.html"), "ready"); } });
  assert.deepEqual(calls, [["ci", "--include=dev", "--no-audit", "--no-fund"], ["run", "build"]]);
  await ensureBuild(directory, () => assert.fail("Existing build should open immediately"));
});
test("HTTP launch exchange, host protection, authenticated setup metadata and provider ZIP", async () => {
  const server = await boot();
  try {
    assert.match(server.info.token, /^[a-f0-9]{64}$/); assert.notEqual(server.info.token, server.admin);
    const url = new URL(browserUrl(server.info)); assert.equal(url.search, ""); assert.equal(url.hash, "#setup-token=" + server.info.token);
    assert.equal((await request(server.origin, "/api/setup")).status, 401);
    assert.equal((await request(server.origin, "/api/setup/provider.zip")).status, 401);
    const body = {token: server.info.token};
    for (const headers of [{Host: "evil.example"}, {Forwarded: "for=127.0.0.1"}, {"X-Forwarded-Host": new URL(server.origin).host}, {Origin: "https://evil.example"}]) assert.equal((await request(server.origin, "/api/launch-login", {body, headers})).status, 403);
    assert.equal((await request(server.origin, "/api/launch-login", {body: {token: server.admin}})).status, 401);
    const login = await request(server.origin, "/api/launch-login", {body, headers: {Origin: server.origin}});
    assert.equal(login.status, 200); const cookie = login.headers["set-cookie"][0]; assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await request(server.origin, "/api/launch-login", {body})).status, 401);
    const headers = {Cookie: cookie.split(";")[0], Host: "poisoned.example"};
    const setup = await request(server.origin, "/api/setup", {headers}); assert.equal(setup.status, 200); assert.deepEqual(setup.json(), {coordinator: server.origin, localOnly: true});
    const download = await request(server.origin, "/api/setup/provider.zip", {headers}); assert.equal(download.status, 200); assert.equal(download.headers["content-type"], "application/zip");
    const entries = archiveEntries(download.bytes); assert.deepEqual([...entries.keys()], [...PROVIDER_FILES, PROVIDER_SERVICE_CONFIG, PROVIDER_MANIFEST]);
    for (const name of PROVIDER_FILES) assert.deepEqual(entries.get(name), await providerFileData(root, name));
    assert.deepEqual(JSON.parse(entries.get(PROVIDER_MANIFEST)), (await providerPackage(root, {coordinator: server.origin})).manifest);
    assert.deepEqual(JSON.parse(entries.get(PROVIDER_SERVICE_CONFIG)), {coordinator: server.origin});
    assert.ok(!server.logs().includes(server.info.token)); assert.ok(!server.logs().includes(server.admin));
  } finally { await server.close(); }
});
test("normal, secure-cookie and externally bound launches do not issue auto-login tickets", async () => {
  for (const options of [{RELAY_LAUNCH_LOGIN: "0"}, {RELAY_SECURE_COOKIE: "1"}, {RELAY_HOST: "0.0.0.0"}]) {
    const server = await boot(options);
    try { assert.equal(server.info?.token, undefined); assert.equal((await request(server.origin, "/api/launch-login", {body: {token: "a".repeat(64)}})).status, 403); }
    finally { await server.close(); }
  }
});
test("public HTTPS setup origin is trusted configuration and keeps manual authentication", async () => {
  const listener = http.createServer();
  await new Promise(accept => listener.listen(0, "127.0.0.1", accept));
  const port = listener.address().port;
  await new Promise(accept => listener.close(accept));
  const server = await boot({RELAY_PUBLIC_ORIGIN: "https://relay.example/", RELAY_PORT: String(port)});
  const local = "http://127.0.0.1:" + port;
  try {
    assert.equal(server.info.token, undefined);
    assert.equal(server.info.origin, "https://relay.example");
    assert.equal((await request(local, "/api/launch-login", {body: {token: "a".repeat(64)}})).status, 403);
    const login = await request(local, "/api/login", {body: {token: server.admin}, headers: {Origin: "https://relay.example"}});
    assert.equal(login.status, 200);
    const headers = {Cookie: login.headers["set-cookie"][0].split(";")[0], Host: "attacker.example"};
    const setup = await request(local, "/api/setup", {headers});
    assert.deepEqual(setup.json(), {coordinator: "https://relay.example", localOnly: false});
    for (const path of ["/api/setup/provider.zip", "/api/participation/provider.zip"]) {
      const download = await request(local, path, {headers});
      assert.equal(download.status, 200);
      const entries = archiveEntries(download.bytes);
      assert.deepEqual(JSON.parse(entries.get(PROVIDER_SERVICE_CONFIG)), {coordinator: "https://relay.example"});
      assert.deepEqual(JSON.parse(entries.get(PROVIDER_MANIFEST)), (await providerPackage(root, {coordinator: "https://relay.example"})).manifest);
    }
    assert.equal(browserUrl(server.info), "https://relay.example/");
  } finally { await server.close(); }
});
test("launcher opens only after real HTTP server is ready and supports graceful shutdown", async () => {
  const data = await temp();
  const code = `import {launch} from './scripts/launch.mjs'; const exit = await launch({open: async value => { const url = new URL(value); if (!url.hash.startsWith('#setup-token=')) throw Error('Missing ticket'); const result = await fetch(url.origin + '/api/launch-login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:url.hash.slice(13)})}); if (result.status !== 200) throw Error('Exchange failed'); console.log('LAUNCH_EXCHANGE_OK'); process.emit('SIGTERM'); }}); process.exitCode = exit;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {cwd: root, env: {...process.env, RELAY_ADMIN_TOKEN: randomBytes(32).toString("hex"), RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_PUBLIC_ORIGIN: "", RELAY_SECURE_COOKIE: "0", RELAY_DATA_DIR: data}, stdio: ["ignore", "pipe", "pipe"], windowsHide: true});
  let output = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  const exit = await new Promise((accept, reject) => { const timer = setTimeout(() => {child.kill(); reject(new Error("Launcher timeout: " + output));}, 15000); child.once("exit", code => {clearTimeout(timer); accept(code);}); child.once("error", reject); });
  assert.equal(exit, 0, output); assert.match(output, /LAUNCH_EXCHANGE_OK/); assert.ok(!output.includes("#setup-token="));
});
