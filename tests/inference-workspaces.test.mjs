import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createInferenceGateway} from "../lib/relay/inference.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const template = "workspace synthetic template", key = "p".repeat(48);
const input = extra => ({model: "model", session_id: "session", messages: [{role: "user", content: "full history"}], max_tokens: 16, ...extra});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
  assert.fail("Expected workspace state was not reached.");
}
const frame = content => `data: ${JSON.stringify({id: "reply", model: "model", choices: [{index: 0, delta: {role: "assistant", content}, finish_reason: null}]})}\n\n`;
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":3}}\n\ndata: [DONE]\n\n';
const stream = (content, done = true) => new Response(frame(content) + (done ? ending : ""), {headers: {"Content-Type": "text/event-stream"}});

function fixture(t, {store, settings} = {}) {
  const config = settings ?? {version: 1, recoveryTimeoutMs: 1000, requestTimeoutMs: 10000,
    tenants: [{id: "renter", keySha256: hash("r".repeat(48)), models: ["model"], maxConcurrent: 2}],
    groups: ["primary", "standby"].map((id, index) => ({id, model: "model", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: `http://127.0.0.1:${8081 + index}`, modelSha256: "a".repeat(64), templateSha256: hash(template), contextTokens: 512, slots: 1,
      hourlyCost: index + 1, currency: "CR", modelArchitecture: {layers: 1, kvHeads: 1, headDim: 64, kvBytes: 2},
      gpus: [{id: id + "/GPU", providerKeySha256: hash(key), layers: 1, vramMiB: 1024, weightsMiB: 100, workspaceMiB: 100, reserveMiB: 100}]}))};
  const backend = {chat: null, health: null, erase: null, calls: []};
  const gateway = createInferenceGateway(config, {workspaceStore: store, fetchImpl: async (url, init) => {
    init.signal.throwIfAborted();
    const parsed = new URL(url), path = parsed.pathname, id = parsed.port === "8081" ? "primary" : "standby";
    const body = init.body && JSON.parse(init.body);
    backend.calls.push({id, path, body});
    if (path === "/health") return backend.health ? backend.health(id) : Response.json({status: "ok"});
    if (path === "/props") return Response.json({total_slots: 1, default_generation_settings: {n_ctx: 512}, chat_template: template});
    if (path === "/v1/models") return Response.json({data: [{id: "model"}]});
    if (path === "/slots") return Response.json([{id: 0, is_processing: false}]);
    if (path === "/slots/0") return backend.erase ? backend.erase(id) : Response.json({id_slot: 0, n_erased: 0});
    if (path.endsWith("/input_tokens")) return Response.json({input_tokens: 10});
    if (path === "/v1/chat/completions") return backend.chat ? backend.chat(id, body, init.signal) : stream(id);
    assert.fail(url);
  }});
  t.after(() => gateway.close());
  const tenant = config.tenants.length ? gateway.authenticate("Bearer " + "r".repeat(48)) : gateway.operator;
  const create = () => gateway.createWorkspace(tenant, {name: "My workspace", candidateId: "primary~standby"});
  return {gateway, backend, config, tenant, create};
}

test("workspace reserves both groups, restricts ownership, persists selection, and rechecks restored contracts", async t => {
  const saved = new Map(), store = {load: () => [...saved.values()], save: value => saved.set(value.id, structuredClone(value))};
  const f = fixture(t, {store}), space = await f.create();
  assert.equal(space.totalHourlyCost, 3);
  assert.equal(space.status, "ready");
  assert.equal(f.gateway.authenticate("Bearer " + space.accessKey, space.id).workspaceOnly, space.id);
  assert.throws(() => f.gateway.authenticate("Bearer " + space.accessKey), error => error.status === 401);
  assert.ok(!JSON.stringify(saved.get(space.id)).includes(space.accessKey));
  assert.ok(!JSON.stringify(f.gateway.workspaceSnapshot(f.tenant)).includes(space.accessKey));
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 0);
  await assert.rejects(f.create(), error => error.status === 409);
  await assert.rejects(f.gateway.complete(f.tenant, input()), error => error.status === 404);
  assert.throws(() => f.gateway.completeWorkspace(f.gateway.operator, space.id, input()), error => error.status === 404);
  assert.ok(!JSON.stringify(f.gateway.snapshot()).includes(hash(key)));
  f.gateway.close();
  const restored = fixture(t, {store, settings: f.config});
  assert.equal(restored.gateway.workspaceSnapshot(restored.tenant).workspaces[0].endpoint, space.endpoint);
  assert.equal((await (await restored.gateway.completeWorkspace(restored.tenant, space.id, input())).json()).choices[0].message.content, "primary");
  restored.gateway.close();
  const changed = structuredClone(f.config); changed.groups[1].hourlyCost = 100;
  const mismatch = fixture(t, {store, settings: changed});
  await assert.rejects(mismatch.gateway.completeWorkspace(mismatch.tenant, space.id, input()), error => error.status === 409);
  assert.equal(mismatch.gateway.snapshot().groups.every(group => group.workspaceId === null), true);
  const removed = structuredClone(f.config); removed.tenants = [];
  const orphan = fixture(t, {store, settings: removed});
  assert.equal(orphan.gateway.snapshot().groups.every(group => group.workspaceId === null), true);
});

test("JSON failover replays full history once, hides partial output, and retains idempotency", async t => {
  const f = fixture(t), space = await f.create();
  f.backend.chat = id => stream(id === "primary" ? "DISCARD" : "replacement", id !== "primary");
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input(), undefined, "workspace-request-0001");
  assert.equal(response.headers.get("x-relay-recovered"), "true");
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "replacement");
  assert.equal(result.usage.completion_tokens, 3);
  const calls = f.backend.calls.filter(call => call.path === "/v1/chat/completions");
  assert.deepEqual(calls.map(call => call.id), ["primary", "standby"]);
  assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
  assert.equal(calls[1].body.cache_prompt, false);
  const again = await f.gateway.completeWorkspace(f.tenant, space.id, input(), undefined, "workspace-request-0001");
  assert.equal(again.headers.get("x-relay-duplicate"), "true");
  assert.deepEqual(await again.json(), result);
  const current = f.gateway.workspaceSnapshot(f.tenant).workspaces[0];
  assert.equal(current.status, "degraded"); assert.equal(current.recoveries, 1); assert.equal(current.active, false);
});

for (const restart of [false, true]) test(`stream failover preserves the ${restart ? "explicit restart" : "buffered compatibility"} contract`, async t => {
  const f = fixture(t), space = await f.create();
  f.backend.chat = id => stream(id === "primary" ? "OLD" : "NEW", id !== "primary");
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input({stream: true, restart_on_failure: restart}));
  const text = await response.text();
  assert.match(text, /NEW/);
  if (restart) {
    assert.ok(text.indexOf("OLD") < text.indexOf("relay.restarting"));
    assert.ok(text.indexOf("relay.restarting") < text.indexOf("NEW"));
    assert.ok(text.indexOf("NEW") < text.indexOf("relay.completed"));
    assert.match(text, /"discard":true/);
  } else { assert.doesNotMatch(text, /OLD|relay.restarting/); }
});

for (const externalAbort of [false, true]) test(`workspace restart streams bound unread output and ${externalAbort ? "client abort" : "cancel"} waits for erase ACK`, async t => {
  const f = fixture(t), space = await f.create(), client = new AbortController();
  let pulls = 0, canceled = false;
  const chunk = new TextEncoder().encode(frame("x".repeat(32 * 1024)));
  f.backend.chat = () => new Response(new ReadableStream({
    pull(output) {
      pulls++;
      if (pulls <= 80) output.enqueue(chunk);
      else { output.enqueue(new TextEncoder().encode(ending)); output.close(); }
    },
    cancel() { canceled = true; },
  }, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input({stream: true, restart_on_failure: true}), client.signal);
  await until(() => pulls >= 3);
  await tick(); await tick();
  assert.equal(pulls, 3, `One queued chunk, one pending emit and one upstream prefetch are enough; got ${pulls}.`);
  const eraseGate = deferred(); let erasing = false;
  f.backend.erase = async () => { erasing = true; await eraseGate.promise; return Response.json({id_slot: 0, n_erased: 0}); };
  const cancellation = externalAbort ? (client.abort(), Promise.resolve()) : response.body.cancel();
  await until(() => erasing);
  assert.equal(canceled, true);
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].active, true);
  assert.equal(f.gateway.snapshot().groups[0].active, 1);
  eraseGate.resolve(); await cancellation;
  await until(() => !f.gateway.workspaceSnapshot(f.tenant).workspaces[0].active);
  assert.equal(f.gateway.snapshot().groups[0].active, 0);
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].recoveries, 0);
  if (externalAbort) await assert.rejects(response.text());
});

test("workspace restart applies pressure to small and empty chunks", async t => {
  const f = fixture(t), space = await f.create(), encoder = new TextEncoder();
  for (const content of [frame("small"), ""]) {
    let pulls = 0;
    f.backend.chat = () => new Response(new ReadableStream({pull(output) {
      pulls++;
      if (pulls === 1) output.enqueue(encoder.encode(frame("first")));
      else if (pulls < 40) output.enqueue(encoder.encode(content));
      else { output.enqueue(encoder.encode(ending)); output.close(); }
    }}, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
    const response = await f.gateway.completeWorkspace(f.tenant, space.id, input({stream: true, restart_on_failure: true}));
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await until(() => pulls >= 4); await tick(); await tick();
    assert.equal(pulls, 4, "One consumed frame must leave only three further engine reads in flight.");
    await reader.cancel();
    assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].active, false);
  }
});

test("legacy buffered workspace output drains under pressure and cancels without hanging", async t => {
  const f = fixture(t), space = await f.create();
  const chunks = Array.from({length: 6}, (_, index) => frame(String(index).repeat(32 * 1024)));
  f.backend.chat = () => {
    let index = 0;
    return new Response(new ReadableStream({pull(output) {
      if (index < chunks.length) output.enqueue(new TextEncoder().encode(chunks[index++]));
      else { output.enqueue(new TextEncoder().encode(ending)); output.close(); }
    }}, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  };
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input({stream: true}));
  await until(() => f.gateway.snapshot().groups[0].requests === 1);
  await tick();
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].active, true, "Delivery remains active while its consumer is stalled.");
  assert.equal(await response.text(), chunks.join("") + ending);
  const canceled = await f.gateway.completeWorkspace(f.tenant, space.id, input({stream: true}));
  await until(() => f.gateway.snapshot().groups[0].requests === 2);
  await canceled.body.cancel();
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].active, false);
});

test("workspace JSON collects fragmented Unicode, reasoning and tool arguments exactly once", async t => {
  const f = fixture(t), space = await f.create();
  const event = delta => `data: ${JSON.stringify({id: "tool-reply", model: "model", choices: [{index: 0, delta, finish_reason: null}]})}\r\n\r\n`;
  const payload = event({role: "assistant", reasoning_content: "생각 👋", tool_calls: [{index: 0, id: "call_", type: "function", function: {name: "wea", arguments: '{"city":'}}]}) +
    event({reasoning_content: " 계속", tool_calls: [{index: 0, id: "1", function: {name: "ther", arguments: '"서울"}'}}]}) +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  f.backend.chat = () => {
    const bytes = new TextEncoder().encode(payload); let offset = 0;
    return new Response(new ReadableStream({pull(output) {
      if (offset === bytes.length) output.close(); else output.enqueue(bytes.subarray(offset, ++offset));
    }}, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  };
  const result = await (await f.gateway.completeWorkspace(f.tenant, space.id, input())).json();
  assert.equal(result.id, "tool-reply");
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(result.choices[0].message, {role: "assistant", reasoning_content: "생각 👋 계속", tool_calls: [
    {id: "call_1", type: "function", function: {name: "weather", arguments: '{"city":"서울"}'}},
  ]});
  f.backend.chat = () => new Response(event({role: "assistant", content: "", tool_calls: []}) + ending, {headers: {"Content-Type": "text/event-stream"}});
  const empty = await (await f.gateway.completeWorkspace(f.tenant, space.id, input())).json();
  assert.deepEqual(empty.choices[0].message, {role: "assistant", content: "", tool_calls: []});
});

test("provider events authenticate each GPU and fence stale processes during regeneration", async t => {
  const f = fixture(t), space = await f.create();
  const event = (state, extra = {}) => ({groupId: "primary", gpuIds: ["primary/GPU"], runtimeId: "run-1", startedAt: 100, state, ...extra});
  assert.throws(() => f.gateway.providerEvent("Bearer " + "x".repeat(48), event("providing")), error => error.status === 403);
  assert.equal(f.gateway.providerEvent("Bearer " + key, event("providing")).ignored, false);
  assert.equal(f.gateway.providerEvent("Bearer " + key, event("released")).ignored, false);
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input());
  assert.equal((await response.json()).choices[0].message.content, "standby");
  assert.equal(f.backend.calls.some(call => call.path === "/v1/chat/completions" && call.id === "primary"), false);
  await f.gateway.stopWorkspace(f.tenant, space.id);
  assert.deepEqual(f.gateway.workspaceSnapshot(f.tenant).candidates.map(item => item.id), ["standby"], "Only the remaining GPU group can be offered again.");
  f.gateway.providerEvent("Bearer " + key, event("providing", {runtimeId: "run-2", startedAt: 101}));
  assert.equal(f.gateway.providerEvent("Bearer " + key, event("released")).ignored, true);
  assert.equal(f.gateway.snapshot().groups[0].providerStates[0].state, "providing");
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 4);
});

test("one active request per space and stop holds reservations through acknowledged cleanup", async t => {
  const f = fixture(t), space = await f.create(), started = deferred(), erased = deferred();
  f.backend.chat = () => new Response(new ReadableStream({start(output) { output.enqueue(new TextEncoder().encode(frame("partial"))); started.resolve(); }}), {headers: {"Content-Type": "text/event-stream"}});
  const pending = f.gateway.completeWorkspace(f.tenant, space.id, input());
  const rejected = assert.rejects(pending);
  await started.promise;
  await assert.rejects(f.gateway.completeWorkspace(f.tenant, space.id, input({session_id: "other"})), error => error.status === 409);
  f.backend.erase = async () => { await erased.promise; return Response.json({id_slot: 0, n_erased: 0}); };
  const stopped = f.gateway.stopWorkspace(f.tenant, space.id);
  await assert.rejects(f.gateway.completeWorkspace(f.tenant, space.id, input()), error => error.status === 410);
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 0);
  erased.resolve(); await rejected;
  assert.equal((await stopped).status, "stopped");
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 4);
});

test("recovery deadline ends at first actual token, even when a JSON answer finishes later", async t => {
  const f = fixture(t), space = await f.create();
  f.backend.chat = id => {
    if (id === "primary") return stream("partial", false);
    return new Response(new ReadableStream({start(output) {
      output.enqueue(new TextEncoder().encode(frame("long healthy answer")));
      setTimeout(() => { output.enqueue(new TextEncoder().encode(ending)); output.close(); }, 1200);
    }}), {headers: {"Content-Type": "text/event-stream"}});
  };
  const response = await f.gateway.completeWorkspace(f.tenant, space.id, input());
  assert.equal((await response.json()).choices[0].message.content, "long healthy answer");
  assert.ok(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].lastRecoveryMs < 1000);
});

test("stop during warm verification waits for creation to settle before offering those GPUs again", async t => {
  const f = fixture(t), first = await f.create();
  await f.gateway.stopWorkspace(f.tenant, first.id);
  const entered = deferred(), release = deferred();
  f.backend.health = async () => { entered.resolve(); await release.promise; return Response.json({status: "ok"}); };
  const creation = f.create(), failed = assert.rejects(creation);
  await entered.promise;
  const preparing = f.gateway.workspaceSnapshot(f.tenant).workspaces.find(space => space.status === "preparing");
  const stopped = f.gateway.stopWorkspace(f.tenant, preparing.id);
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 0);
  release.resolve(); await failed; await stopped;
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).candidates.length, 4);
});

test("single-group workspace reserves only its group, restores, and never switches to an unselected GPU", async t => {
  const saved = new Map(), store = {load: () => [...saved.values()], save: value => saved.set(value.id, structuredClone(value))};
  const f = fixture(t, {store});
  const space = await f.gateway.createWorkspace(f.tenant, {name: "One group", candidateId: "primary"});
  assert.equal(space.standbyGroupId, null);
  assert.equal(space.totalHourlyCost, 1);
  assert.equal(space.status, "ready");
  assert.deepEqual(f.gateway.workspaceSnapshot(f.tenant).candidates.map(item => item.id), ["standby"]);
  assert.ok(f.backend.calls.every(call => call.id === "primary"), "No standby verification or KV reservation");
  assert.equal((await f.gateway.completeWorkspace(f.tenant, space.id, input())).status, 200);
  assert.equal(f.gateway.workspaceSnapshot(f.tenant).workspaces[0].status, "ready");
  f.gateway.close();

  const restored = fixture(t, {store, settings: f.config});
  const tenant = restored.gateway.authenticate("Bearer " + space.accessKey, space.id);
  assert.equal((await restored.gateway.completeWorkspace(tenant, space.id, input())).status, 200);
  restored.backend.chat = () => stream("unfinished", false);
  await assert.rejects(restored.gateway.completeWorkspace(tenant, space.id, input()), /ended without/);
  const failed = restored.gateway.workspaceSnapshot(restored.tenant).workspaces[0];
  assert.equal(failed.recoveries, 0);
  assert.equal(failed.activeGroupId, "primary");
  assert.equal(failed.status, "unavailable");
  assert.ok(restored.backend.calls.every(call => call.id === "primary"));
  restored.backend.chat = null;
  assert.equal((await restored.gateway.completeWorkspace(tenant, space.id, input())).status, 200);
  assert.equal(restored.gateway.workspaceSnapshot(restored.tenant).workspaces[0].status, "ready");
  const event = {groupId: "primary", gpuIds: ["primary/GPU"], runtimeId: "single-runtime", startedAt: 1};
  restored.gateway.providerEvent("Bearer " + key, {...event, state: "providing"});
  restored.backend.chat = () => {
    restored.gateway.providerEvent("Bearer " + key, {...event, state: "released"});
    assert.equal(restored.gateway.workspaceSnapshot(restored.tenant).workspaces[0].status, "unavailable");
    return stream("interrupted");
  };
  await assert.rejects(restored.gateway.completeWorkspace(tenant, space.id, input()), error => error.status === 503);
  assert.equal(restored.gateway.workspaceSnapshot(restored.tenant).workspaces[0].recoveries, 0);
  await restored.gateway.stopWorkspace(restored.tenant, space.id);
  assert.deepEqual(restored.gateway.workspaceSnapshot(restored.tenant).candidates.map(item => item.id), ["standby"]);
});
