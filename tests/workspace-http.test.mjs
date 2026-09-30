// Real Relay HTTP/SQLite boundaries with two synthetic engines; no GPU or model is exercised.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {fork} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const input = {model: "workspace-model", messages: [{role: "user", content: "hello"}], max_tokens: 16};

async function fixture(t) {
  const keys = Object.fromEntries(["alice", "bob", "admin", "primary", "standby"].map(name => [name, randomBytes(32).toString("hex")]));
  const template = "synthetic workspace template", engines = [];
  for (const id of ["primary", "standby"]) {
    const state = {id, generated: [], active: false};
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      const json = data => {res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(data));};
      if (req.url === "/health") return json({status: "ok"});
      if (req.url === "/props") return json({total_slots: 1, default_generation_settings: {n_ctx: 8192}, chat_template: template});
      if (req.url === "/v1/models") return json({data: [{id: "workspace-model"}]});
      if (req.url === "/slots") return json([{id: 0, is_processing: state.active}]);
      if (req.url === "/slots/0?action=erase") return json({id_slot: 0, n_erased: 0});
      if (req.url === "/v1/chat/completions/input_tokens") return json({input_tokens: 8});
      if (req.url === "/v1/chat/completions") {
        state.generated.push(body);
        state.active = true; res.once("close", () => {state.active = false;});
        if (body.stream) {
          res.writeHead(200, {"Content-Type": "text/event-stream"});
          res.write(`data: ${JSON.stringify({id: "synthetic-" + id, model: "workspace-model", choices: [{index: 0, delta: {role: "assistant", content: id + " answer"}, finish_reason: null}]})}\n\n`);
          if (id !== "primary" || body.messages[0].content !== "hold") res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\ndata: [DONE]\n\n');
          return;
        }
        return json({id: "synthetic-" + id, object: "chat.completion", model: "workspace-model",
          choices: [{index: 0, message: {role: "assistant", content: id + " answer"}, finish_reason: "stop"}],
          usage: {prompt_tokens: 8, completion_tokens: 2, total_tokens: 10}});
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    engines.push({id, state, server});
    t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  }
  await mkdir(resolve(root, "work"), {recursive: true});
  const directory = await mkdtemp(resolve(root, "work/workspace-http-qa-")), configPath = resolve(directory, "inference.json");
  await writeFile(configPath, JSON.stringify({version: 1, requestTimeoutMs: 10000,
    tenants: ["alice", "bob"].map(id => ({id, keySha256: hash(keys[id]), models: ["workspace-model"], maxConcurrent: 2})),
    groups: engines.map(({id, server}) => ({id, model: "workspace-model", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: `http://127.0.0.1:${server.address().port}`, modelSha256: "a".repeat(64), templateSha256: hash(template),
      quantization: "Q4_K_M", engineVersion: "b10964", hourlyCost: 2, currency: "CR", contextTokens: 8192, slots: 1,
      modelArchitecture: {layers: 64, kvHeads: 8, headDim: 128, kvBytes: 2},
      gpus: [{id: id + "/GPU-1", providerKeySha256: hash(keys[id]), vramMiB: 24576,
        weightsMiB: 12000, workspaceMiB: 1024, reserveMiB: 1024, layers: 64}]}))}));
  let child, origin, logs = "", cookie;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => {clearTimeout(timer); resolve();});
      if (child.connected) child.send("relay:shutdown"); else child.kill();
    });
  }
  const bearer = name => ({Authorization: `Bearer ${keys[name]}`});
  const call = (path, {body, headers = {}, method, signal} = {}) => fetch(origin + path, {
    method: method ?? (body === undefined ? "GET" : "POST"), headers: {"Content-Type": "application/json", ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
  async function boot() {
    child = fork(resolve(root, "standalone/server.mjs"), [], {cwd: root, windowsHide: true, execArgv: [],
      env: {...process.env, RELAY_ADMIN_TOKEN: keys.admin, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_SECURE_COOKIE: "0",
        RELAY_PUBLIC_ORIGIN: "", RELAY_LAUNCH_LOGIN: "1", RELAY_DATA_DIR: directory, RELAY_INFERENCE_CONFIG: configPath},
      stdio: ["ignore", "pipe", "pipe", "ipc"]});
    child.stdout.on("data", chunk => {logs += chunk;}); child.stderr.on("data", chunk => {logs += chunk;});
    origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(Error("Synthetic workspace server startup timed out"));}, 10000);
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("exit", code => {clearTimeout(timer); reject(Error(`Synthetic workspace server startup exited ${code}: ${logs}`));});
      child.on("message", message => {if (message?.type === "relay:launch-ready") {clearTimeout(timer); resolve(message.origin);}});
    });
    const login = await call("/api/login", {body: {token: keys.admin}});
    assert.equal(login.status, 200);
    cookie = {Cookie: login.headers.get("set-cookie").split(";")[0]};
  }
  t.after(async () => { await stop(); await rm(directory, {recursive: true, force: true}); });
  await boot();
  return {call, bearer, engines: engines.map(item => item.state), cookie: () => cookie,
    restart: async () => {await stop(); await boot();},
    snapshot: async () => (await call("/api/inference", {headers: cookie})).json(),
    secretsAbsent: text => Object.values(keys).every(key => !text.includes(key) && !text.includes(hash(key))) &&
      Object.values(keys).every(key => !logs.includes(key))};
}

test("workspace HTTP ownership, warm failover, provider credentials and restart persistence", {timeout: 45000}, async t => {
  const f = await fixture(t), a = f.bearer("alice"), b = f.bearer("bob");
  let space, primaryEvent;
  await t.test("admin cookies, tenant credentials and provider credentials stay separate", async () => {
    assert.equal((await f.call("/v1/workspaces")).status, 401);
    assert.equal((await f.call("/v1/workspaces", {headers: f.cookie()})).status, 401);
    assert.equal((await f.call("/api/inference/workspaces", {headers: a})).status, 401);
    assert.equal((await f.call("/v1/workspaces", {headers: f.bearer("primary")})).status, 401);
    const result = await f.call("/v1/workspaces", {headers: a});
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.candidates.length, 4);
    assert.equal(body.candidates[0].totalHourlyCost, 2);
    assert.equal(body.candidates[0].standbyGroupId, null);
    assert.equal(body.candidates.find(item => item.id === "primary~standby").totalHourlyCost, 4);
    assert.equal(f.secretsAbsent(JSON.stringify(await f.snapshot())), true);
    const created = await f.call("/v1/workspaces", {headers: a, body: {candidateId: "primary~standby", name: "Alice space"}});
    assert.equal(created.status, 201);
    space = await created.json();
    assert.equal(space.ownerId, "alice"); assert.equal(space.status, "ready");
    assert.equal(space.endpoint, `/v1/workspaces/${space.id}/chat/completions`);
    assert.deepEqual((await (await f.call("/v1/workspaces", {headers: b})).json()).workspaces, []);
    assert.equal((await f.call(space.endpoint, {headers: b, body: input})).status, 404);
    assert.equal((await f.call(`/v1/workspaces/${space.id}`, {headers: b, method: "DELETE"})).status, 404);
    assert.equal((await f.call(`/api/inference/workspaces/${space.id}/chat`, {headers: f.cookie(), body: input})).status, 404);
  });
  await t.test("selected group produces a response and its provider can trigger warm standby recovery", async () => {
    const first = await f.call(space.endpoint, {headers: a, body: input});
    assert.equal(first.status, 200, await first.clone().text()); assert.equal(first.headers.get("x-relay-group"), "primary");
    assert.equal((await first.json()).choices[0].message.content, "primary answer");
    const event = primaryEvent = {groupId: "primary", gpuIds: ["primary/GPU-1"], runtimeId: "runtime-primary", startedAt: Date.now(), state: "providing"};
    assert.equal((await f.call("/api/inference/provider", {headers: a, body: event})).status, 403);
    assert.equal((await f.call("/api/inference/provider", {headers: f.cookie(), body: event})).status, 401);
    assert.equal((await f.call("/api/inference/provider", {headers: f.bearer("standby"), body: event})).status, 403);
    const providing = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: event});
    assert.equal(providing.status, 200); assert.equal((await providing.json()).ignored, false);
    const streaming = await f.call(space.endpoint, {headers: a, body: {...input, stream: true,
      restart_on_failure: true, messages: [{role: "user", content: "hold"}]}});
    assert.equal(streaming.status, 200);
    const reader = streaming.body.getReader(), decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value, {stream: true});
    assert.match(output, /primary answer/);
    assert.equal((await f.call(space.endpoint, {headers: a, body: input})).status, 409);
    for (const state of ["reclaiming", "released"]) {
      const response = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: {...event, state}});
      assert.equal(response.status, 200); assert.equal((await response.json()).ignored, false);
    }
    const stale = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: {...event, state: "reclaiming", runtimeId: "old-runtime"}});
    assert.equal((await stale.json()).ignored, true);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += decoder.decode(next.value, {stream: true});
    }
    output += decoder.decode();
    assert.match(output, /primary answer[\s\S]*event: relay.restarting[\s\S]*"discard":true[\s\S]*standby answer[\s\S]*event: relay.completed/);
    assert.deepEqual(f.engines[0].generated.at(-1).messages, f.engines[1].generated[0].messages);
    const recovered = await f.call(space.endpoint, {headers: a, body: input});
    assert.equal(recovered.status, 200); assert.equal(recovered.headers.get("x-relay-group"), "standby");
    assert.equal(recovered.headers.get("x-relay-recovered"), "false");
    assert.equal((await recovered.json()).choices[0].message.content, "standby answer");
    const status = await (await f.call("/v1/workspaces", {headers: a})).json();
    assert.equal(status.workspaces[0].recoveries, 1); assert.equal(status.workspaces[0].status, "degraded");
  });
  await t.test("same workspace address and owner survive a central server restart", async () => {
    await f.restart();
    const provider = (await f.snapshot()).groups.find(group => group.id === "primary").providerStates[0];
    assert.equal(provider.state, "released"); assert.equal(provider.runtimeId, primaryEvent.runtimeId);
    const result = await f.call("/v1/workspaces", {headers: a});
    assert.equal(result.status, 200);
    const restored = (await result.json()).workspaces[0];
    assert.equal(restored.id, space.id); assert.equal(restored.endpoint, space.endpoint);
    assert.equal(restored.ownerId, "alice"); assert.equal(restored.active, false);
    assert.equal((await f.call(space.endpoint, {headers: b, body: input})).status, 404);
    const response = await f.call(space.endpoint, {headers: a, body: input});
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, "standby answer");
    const deleted = await f.call(`/v1/workspaces/${space.id}`, {headers: a, method: "DELETE"});
    assert.equal(deleted.status, 200); assert.equal((await deleted.json()).status, "stopped");
    assert.equal((await f.call(space.endpoint, {headers: a, body: input})).status, 410);
    const oldEvent = primaryEvent;
    primaryEvent = {...oldEvent, runtimeId: "runtime-after-return", startedAt: oldEvent.startedAt + 1};
    const resumed = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: primaryEvent});
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).ignored, false);
    await f.restart();
    const stale = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: {...oldEvent, state: "reclaiming"}});
    assert.equal(stale.status, 200); assert.equal((await stale.json()).ignored, true);
    for (const state of ["reclaiming", "released"]) {
      const returned = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: {...primaryEvent, state}});
      assert.equal(returned.status, 200); assert.equal((await returned.json()).ignored, false);
    }
    const stopped = (await (await f.call("/v1/workspaces", {headers: a})).json()).workspaces[0];
    assert.equal(stopped.status, "stopped"); assert.equal(stopped.id, space.id);
  });
  await t.test("an administrator's delete rejects a cross-origin request", async () => {
    primaryEvent = {...primaryEvent, runtimeId: "runtime-operator", startedAt: primaryEvent.startedAt + 1};
    const resumed = await f.call("/api/inference/provider", {headers: f.bearer("primary"), body: primaryEvent});
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).ignored, false);
    const created = await f.call("/api/inference/workspaces", {headers: f.cookie(), body: {name: "Operator space", candidateId: "primary~standby"}});
    assert.equal(created.status, 201);
    const operatorSpace = await created.json();
    const access = {Authorization: `Bearer ${operatorSpace.accessKey}`};
    assert.equal((await f.call(operatorSpace.endpoint, {headers: access, body: input})).status, 200);
    assert.equal((await f.call("/v1/workspaces", {headers: access})).status, 401);
    assert.equal((await f.call(`/v1/workspaces/${operatorSpace.id}`, {headers: access, method: "DELETE"})).status, 403);
    assert.ok(!JSON.stringify(await f.snapshot()).includes(operatorSpace.accessKey));
    const path = `/api/inference/workspaces/${operatorSpace.id}`;
    assert.equal((await f.call(path, {headers: {...f.cookie(), Origin: "https://untrusted.example"}, method: "DELETE"})).status, 403);
    assert.equal((await f.call(path, {headers: f.cookie(), method: "DELETE"})).status, 200);
    assert.equal(f.secretsAbsent(JSON.stringify(await f.snapshot())), true);
  });
});
