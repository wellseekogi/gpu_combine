import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {fork} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = extra => ({model: "test-model", messages: [{role: "user", content: "hello"}], max_tokens: 16, ...extra});

async function fixture(t, {requestTimeoutMs = 10000, chatDelayMs = 0} = {}) {
  const key = randomBytes(32).toString("hex"), admin = randomBytes(32).toString("hex");
  const template = "synthetic HTTP test template", state = {active: false, generated: [], counts: [], erased: 0};
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const json = data => {res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(data));};
    if (req.url === "/health") return json({status: "ok"});
    if (req.url === "/props") return json({total_slots: 1, default_generation_settings: {n_ctx: state.context ?? 8192}, chat_template: template});
    if (req.url === "/v1/models") return json({data: [{id: "test-model"}]});
    if (req.url === "/slots") return json([{id: 0, n_ctx: 8192, is_processing: state.active}]);
    if (req.url === "/slots/0?action=erase") {
      while (state.active && !res.destroyed) await pause(10);
      state.erased++; return json({id_slot: 0, n_erased: 0});
    }
    if (req.url === "/v1/chat/completions/input_tokens") {
      state.counts.push(body);
      return json({object: "response.input_tokens", input_tokens: body.messages[0].content === "oversized" ? 8192 : 8});
    }
    if (req.url === "/v1/chat/completions") {
      state.generated.push(body); state.active = true;
      res.once("close", () => {state.active = false;});
      if (chatDelayMs) await pause(chatDelayMs);
      if (res.destroyed) return;
      if (body.stream) {
        res.writeHead(200, {"Content-Type": "text/event-stream"});
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"synthetic"},"finish_reason":null}]}\n\n');
        if (body.messages[0].content !== "hold") res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      return json({id: "synthetic-result", object: "chat.completion", model: "test-model",
        choices: [{index: 0, message: {role: "assistant", content: "synthetic answer"}, finish_reason: "stop"}],
        usage: {prompt_tokens: 8, completion_tokens: 2, total_tokens: 10}});
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  await mkdir(resolve(root, "work"), {recursive: true});
  const directory = await mkdtemp(resolve(root, "work/inference-http-qa-"));
  const configPath = resolve(directory, "inference.json");
  await writeFile(configPath, "\uFEFF" + JSON.stringify({version: 1, requestTimeoutMs,
    tenants: [{id: "tenant-a", keySha256: hash(key), models: ["test-model"], maxConcurrent: 1}],
    groups: [{id: "http-test", model: "test-model", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: `http://127.0.0.1:${backend.address().port}`, modelSha256: "a".repeat(64), templateSha256: hash(template),
      contextTokens: 8192, slots: 1, modelArchitecture: {layers: 64, kvHeads: 8, headDim: 128, kvBytes: 2},
      gpus: [{id: "synthetic/GPU-1", vramMiB: 24576, weightsMiB: 12000, workspaceMiB: 1024, reserveMiB: 1024, layers: 64}]}]}));
  const child = fork(resolve(root, "standalone/server.mjs"), [], {cwd: root, windowsHide: true,
    env: {...process.env, RELAY_ADMIN_TOKEN: admin, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_SECURE_COOKIE: "0",
      RELAY_PUBLIC_ORIGIN: "", RELAY_LAUNCH_LOGIN: "1", RELAY_DATA_DIR: directory, RELAY_INFERENCE_CONFIG: configPath},
    stdio: ["ignore", "pipe", "pipe", "ipc"]});
  let logs = "", origin, ready = false;
  child.stdout.on("data", chunk => {logs += chunk;}); child.stderr.on("data", chunk => {logs += chunk;});
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => {clearTimeout(timer); resolve();});
      if (child.connected) child.send("relay:shutdown"); else child.kill();
    });
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Synthetic relay startup timeout")), 10000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("exit", code => {if (!ready) {clearTimeout(timer); reject(Error(`Synthetic relay startup exit ${code}`));}});
    child.on("message", message => {
      if (message?.type === "relay:launch-ready") origin = message.origin;
      if (message === "relay:ready") ready = true;
      if (origin && ready) {clearTimeout(timer); resolve();}
    });
  });
  const call = (path, {body, headers = {}, signal} = {}) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", headers: {"Content-Type": "application/json", ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
  const bearer = {Authorization: `Bearer ${key}`};
  const login = await call("/api/login", {body: {token: admin}});
  assert.equal(login.status, 200);
  const cookie = {Cookie: login.headers.get("set-cookie").split(";")[0]};
  const snapshot = async () => (await call("/api/inference", {headers: cookie})).json();
  return {call, bearer, cookie, state, snapshot, keyHash: hash(key), secretsAbsent: () => !logs.includes(key) && !logs.includes(admin)};
}

test("synthetic backend through the real inference HTTP listener", {timeout: 30000}, async t => {
  const f = await fixture(t);
  await t.test("tenant keys, admin cookies, model scopes and origins remain separate", async () => {
    assert.equal((await f.call("/v1/models")).status, 401);
    assert.equal((await f.call("/v1/models", {headers: {Authorization: "Bearer " + "x".repeat(64)}})).status, 401);
    assert.equal((await f.call("/v1/models", {headers: f.cookie})).status, 401);
    assert.equal((await f.call("/api/inference", {headers: f.bearer})).status, 401);
    const models = await f.call("/v1/models", {headers: f.bearer});
    assert.equal(models.status, 200); assert.deepEqual((await models.json()).data.map(model => model.id), ["test-model"]);
    assert.equal((await f.call("/v1/chat/completions", {headers: f.bearer, body: input({model: "unauthorized"})})).status, 403);
    assert.equal((await f.call("/v1/chat/completions", {headers: {...f.bearer, Origin: "https://evil.example"}, body: input()})).status, 403);
    assert.equal(JSON.stringify(await f.snapshot()).includes(f.keyHash), false);
    assert.equal(f.secretsAbsent(), true);
  });
  await t.test("native option rejection and exact context admission prevent GPU generation", async () => {
    assert.equal((await f.call("/v1/chat/completions", {headers: f.bearer, body: input({n_predict: -1})})).status, 400);
    assert.equal((await f.call("/v1/chat/completions", {headers: f.bearer,
      body: input({messages: [{role: "user", content: "oversized"}]})})).status, 422);
    assert.equal(f.state.generated.length, 0);
    assert.equal(f.state.counts.length, 1);
    assert.equal((await f.snapshot()).groups[0].active, 0);
  });
  await t.test("JSON and SSE responses traverse actual HTTP and preserve output", async () => {
    const response = await f.call("/v1/chat/completions", {headers: f.bearer, body: input()});
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-relay-group"), "http-test");
    assert.equal((await response.json()).choices[0].message.content, "synthetic answer");
    assert.equal(f.state.generated[0].id_slot, 0); assert.equal(f.state.generated[0].cache_prompt, false);
    assert.equal(f.state.generated[0].n, 1);
    const stream = await f.call("/v1/chat/completions", {headers: f.bearer, body: input({stream: true})});
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    assert.match(await stream.text(), /synthetic[\s\S]*data: \[DONE\]/);
    const status = await f.snapshot(); assert.equal(status.groups[0].active, 0); assert.equal(status.groups[0].requests, 2);
  });
  await t.test("real client disconnect cancels upstream, confirms cleanup and permits a subsequent request", async () => {
    const controller = new AbortController(), before = f.state.erased;
    const response = await f.call("/v1/chat/completions", {headers: f.bearer, signal: controller.signal,
      body: input({stream: true, messages: [{role: "user", content: "hold"}]})});
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
    assert.equal((await f.snapshot()).groups[0].active, 1);
    const saturated = await f.call("/v1/chat/completions", {headers: f.bearer, body: input()});
    assert.equal(saturated.status, 429); assert.equal(saturated.headers.get("retry-after"), "1");
    controller.abort(); await reader.cancel().catch(() => {});
    let status;
    for (let i = 0; i < 100; i++) {
      status = await f.snapshot(); if (status.groups[0].active === 0 && !f.state.active) break;
      await pause(20);
    }
    assert.equal(status.groups[0].active, 0); assert.equal(f.state.active, false); assert.ok(f.state.erased > before);
    const next = await f.call("/v1/chat/completions", {headers: f.bearer, body: input()});
    assert.equal(next.status, 200); assert.equal((await next.json()).choices[0].message.content, "synthetic answer");
  });
  await t.test("engine contract failures retain their actionable 503 message instead of a storage error", async () => {
    f.state.context = 4096;
    const response = await f.call("/v1/chat/completions", {headers: f.bearer, body: input()});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /슬롯·문맥·템플릿/);
    f.state.context = 8192;
  });

});

test("authenticated inference can prefill beyond the HTTP intake timeout", {timeout: 35000}, async t => {
  const f = await fixture(t, {requestTimeoutMs: 30000, chatDelayMs: 16000});
  const started = performance.now();
  const response = await f.call("/v1/chat/completions", {
    headers: f.bearer, body: input(), signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "synthetic answer");
  assert.ok(performance.now() - started >= 15500, "The regression must cross the listener's old 15-second deadline.");
  assert.equal(f.state.generated.length, 1);
  assert.equal((await f.snapshot()).groups[0].active, 0);
});
