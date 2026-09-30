import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInferenceGateway, inferenceBody } from "../lib/relay/inference.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const TEMPLATE = "{{ messages }}";
const KEY_A = "a".repeat(48), KEY_B = "b".repeat(48);
const status = (expected) => (error) => error.status === expected;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("Expected backend state was not reached.");
}

function config(slots = 2) {
  return {
    version: 1,
    groups: [{
      id: "lan-group", model: "qwen32b", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: "http://127.0.0.1:8081", modelSha256: "a".repeat(64), templateSha256: hash(TEMPLATE),
      contextTokens: 512, slots,
      modelArchitecture: { layers: 64, kvHeads: 8, headDim: 128, kvBytes: 2 },
      gpus: [
        { id: "a/GPU-1", vramMiB: 16384, weightsMiB: 10000, workspaceMiB: 1024, reserveMiB: 1024, layers: 32 },
        { id: "b/GPU-1", vramMiB: 16384, weightsMiB: 10000, workspaceMiB: 1024, reserveMiB: 1024, layers: 32 },
      ],
    }],
    tenants: [
      { id: "tenant-a", keySha256: hash(KEY_A), models: ["qwen32b"], maxConcurrent: 1 },
      { id: "tenant-b", keySha256: hash(KEY_B), models: ["qwen32b"], maxConcurrent: 2 },
    ],
  };
}

const request = (overrides = {}) => ({
  model: "qwen32b", session_id: "session-1", messages: [{ role: "user", content: "hello" }], max_tokens: 32, ...overrides,
});
const result = () => Response.json({
  id: "answer", choices: [{ index: 0, message: { role: "assistant", content: "hello back" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
});

function fixture(t, options = {}) {
  const settings = options.config ?? config(options.slots ?? 2);
  const backend = {
    calls: [], processing: Array(settings.groups[0].slots).fill(false), inputTokens: 40,
    props: { total_slots: settings.groups[0].slots, default_generation_settings: { n_ctx: 512 }, chat_template: TEMPLATE },
    health: null, erase: null, count: null, chat: null,
  };
  const fetchImpl = async (url, init) => {
    init.signal?.throwIfAborted();
    const parsed = new URL(url), path = parsed.pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const call = { path, query: parsed.search, origin: parsed.origin, body, init };
    backend.calls.push(call);
    assert.equal(init.redirect, "error", "upstream redirects must not escape loopback validation");
    if (path === "/health") return backend.health ? backend.health(call) : Response.json({ status: "ok" });
    if (path === "/props") return Response.json(backend.props);
    if (path === "/v1/models") return Response.json({ data: [{ id: settings.groups.find(group => group.endpoint === parsed.origin).model }] });
    if (path === "/slots") return Response.json(backend.processing.map((busy, id) => ({ id, is_processing: busy })));
    if (/^\/slots\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      assert.equal(parsed.searchParams.get("action"), "erase");
      if (backend.erase) return backend.erase(id, call);
      if (backend.processing[id]) return Response.json({ error: "busy" }, { status: 503 });
      return Response.json({ id_slot: id, n_erased: 40 });
    }
    if (path === "/v1/chat/completions/input_tokens")
      return backend.count ? backend.count(body, call) : Response.json({ input_tokens: backend.inputTokens });
    if (path === "/v1/chat/completions") return backend.chat ? backend.chat(body, call) : result();
    assert.fail(`Unexpected backend request: ${url}`);
  };
  const gateway = createInferenceGateway(settings, { fetchImpl, clock: options.clock ?? Date.now, monotonicClock: options.monotonicClock });
  t.after(() => gateway.close());
  return {
    gateway, backend,
    a: gateway.authenticate(`Bearer ${KEY_A}`), b: gateway.authenticate(`Bearer ${KEY_B}`),
  };
}

const generations = (backend) => backend.calls.filter((call) => call.path === "/v1/chat/completions");
const erases = (backend) => backend.calls.filter((call) => /^\/slots\/\d+$/.test(call.path));

test("direct routing uses idle groups, keeps tenant KV affinity, and respects caps across groups", async t => {
  const settings = config(1), second = structuredClone(settings.groups[0]);
  second.id = "second"; second.endpoint = "http://127.0.0.1:8082";
  second.gpus = second.gpus.map(gpu => ({...gpu, id: "second/" + gpu.id}));
  settings.groups.push(second);
  let now = 1000;
  const {gateway, backend, a, b} = fixture(t, {config: settings, clock: () => now});
  const gate = deferred();
  backend.chat = (_, call) => call.origin.endsWith(":8081") ? gate.promise : result();
  const busy = gateway.complete(a, request());
  await until(() => generations(backend).length === 1);
  await assert.rejects(gateway.complete(a, request({session_id: "another"})), status(429));
  const other = await gateway.complete(b, request());
  assert.equal(other.headers.get("x-relay-group"), "second", "An idle group serves while the first group is full");
  assert.equal(generations(backend).at(-1).body.cache_prompt, false, "Same session ID across tenants never shares KV");
  gate.resolve(result()); await busy;
  backend.chat = null;
  const reused = await gateway.complete(b, request());
  assert.equal(reused.headers.get("x-relay-group"), "second");
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
  now += 300001;
  const expired = await gateway.complete(b, request());
  assert.equal(expired.headers.get("x-relay-group"), "lan-group");
  assert.equal(generations(backend).at(-1).body.cache_prompt, false, "Expired KV is erased before reassigning a slot");
});

test("a failed first group does not starve unchecked capacity and recalled groups are excluded", async t => {
  const settings = config(1), second = structuredClone(settings.groups[0]);
  second.id = "second"; second.endpoint = "http://127.0.0.1:8082";
  second.gpus = second.gpus.map(gpu => ({...gpu, id: "second/" + gpu.id, providerKeySha256: hash(KEY_B)}));
  settings.groups.push(second);
  const {gateway, backend, b} = fixture(t, {config: settings});
  backend.health = call => Response.json({}, {status: call.origin.endsWith(":8081") ? 503 : 200});
  await assert.rejects(gateway.complete(b, request()), status(503));
  assert.equal(gateway.snapshot().groups[0].status, "unavailable");
  const healthy = await gateway.complete(b, request());
  assert.equal(healthy.headers.get("x-relay-group"), "second");
  backend.health = () => Response.json({}, {status: 503});
  await assert.rejects(gateway.complete(b, request()), status(503));
  await assert.rejects(gateway.complete(b, request()), status(503));
  assert.ok(gateway.snapshot().groups.every(group => group.status === "unavailable"));
  backend.health = call => Response.json({}, {status: call.origin.endsWith(":8081") ? 503 : 200});
  assert.equal((await gateway.complete(b, request())).headers.get("x-relay-group"), "second",
    "Equally unavailable groups rotate so a recovered group is not starved");
  const event = {groupId: "second", gpuIds: second.gpus.map(gpu => gpu.id), runtimeId: "runtime", startedAt: 1};
  gateway.providerEvent("Bearer " + KEY_B, {...event, state: "providing"});
  gateway.providerEvent("Bearer " + KEY_B, {...event, state: "released"});
  backend.health = null;
  const recovered = await gateway.complete(b, request());
  assert.equal(recovered.headers.get("x-relay-group"), "lan-group", "A recalled group cannot receive a cached session");
});

test("request validation rejects native generation overrides and remote multimodal content", () => {
  for (const [key, value] of Object.entries({ id_slot: 0, cache_prompt: true, n_predict: -1, n: 2,
    ignore_eos: true, prompt: "bypass", image_data: [], cache_type_k: "q8_0", stream_options: {} }))
    assert.throws(() => inferenceBody(request({ [key]: value })), status(400));
  assert.throws(() => inferenceBody(request({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "http://internal/private" } },
  ] }] })), status(400));
  for (const bad of [-1, 0, 32769, NaN, Infinity, "32"])
    assert.throws(() => inferenceBody(request({ max_tokens: bad })), status(400));
});

test("valid agent tool messages preserve argument strings and strip session metadata", () => {
  const input = request({
    messages: [
      { role: "user", content: "weather" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Seoul\"}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    tool_choice: "auto", response_format: { type: "json_object" },
  });
  const body = inferenceBody(input);
  assert.equal(body.messages[1].tool_calls[0].function.arguments, "{\"city\":\"Seoul\"}");
  assert.equal(Object.hasOwn(body, "session_id"), false);
  assert.equal(body.n, 1);
  assert.equal(body.stream, false);
  assert.throws(() => inferenceBody(request({ messages: [{ role: "tool", content: "no call ID" }] })), status(400));
});

test("tenant authentication and model permissions fail before contacting an engine", async (t) => {
  const { gateway, backend, a } = fixture(t);
  for (const authorization of [undefined, "Basic x", "Bearer short", `Bearer ${"x".repeat(48)}`])
    assert.throws(() => gateway.authenticate(authorization), status(401));
  assert.deepEqual(gateway.models(a).data.map((model) => model.id), ["qwen32b"]);
  assert.equal(gateway.models(gateway.operator).data[0].context_tokens, 512);
  await assert.rejects(gateway.complete(a, request({ model: "not-allowed" })), status(403));
  assert.equal(backend.calls.length, 0);
  assert.equal(JSON.stringify(gateway.snapshot()).includes(hash(KEY_A)), false);
});

test("two tenants occupy independent slots while tenant caps and group capacity bound concurrency", async (t) => {
  const { gateway, backend, a, b } = fixture(t);
  await gateway.complete(a, request({ session_id: "warmup" }));
  const pending = [];
  backend.chat = (body) => {
    const gate = deferred(); pending.push({ body, gate }); return gate.promise;
  };
  const first = gateway.complete(a, request());
  await until(() => pending.length === 1);
  await assert.rejects(gateway.complete(a, request({ session_id: "a-second" })), status(429));
  const second = gateway.complete(b, request());
  await until(() => pending.length === 2);
  assert.notEqual(pending[0].body.id_slot, pending[1].body.id_slot);
  assert.equal(gateway.snapshot().groups[0].active, 2);
  await assert.rejects(gateway.complete(b, request({ session_id: "b-second" })), status(429));
  pending.forEach(({ gate }) => gate.resolve(result()));
  await Promise.all([first, second]);
  assert.equal(gateway.snapshot().groups[0].active, 0);
});

test("a same-session request is rejected while first-use cache erasure is still pending", async (t) => {
  const { gateway, backend, b } = fixture(t);
  const eraseGate = deferred();
  let held = false;
  backend.erase = async (id) => {
    if (!held) { held = true; await eraseGate.promise; }
    return Response.json({ id_slot: id, n_erased: 0 });
  };
  const first = gateway.complete(b, request());
  await until(() => held);
  await assert.rejects(gateway.complete(b, request()), status(409));
  eraseGate.resolve();
  await first;
  assert.equal(generations(backend).length, 1);
});

test("exact full-history token preflight rejects overflow before any generation and accepts the boundary", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  const messages = [
    { role: "system", content: "remember the complete conversation" },
    { role: "user", content: "earlier" }, { role: "assistant", content: "earlier answer" },
    { role: "user", content: "now" },
  ];
  backend.inputTokens = 481;
  await assert.rejects(gateway.complete(a, request({ messages })), status(422));
  assert.equal(generations(backend).length, 0);
  const preflight = backend.calls.find((call) => call.path.endsWith("input_tokens"));
  assert.deepEqual(preflight.body.messages, messages);
  assert.equal(preflight.body.max_tokens, 32);
  assert.equal(preflight.body.stream, false);
  assert.equal(gateway.snapshot().groups[0].active, 0);
  backend.inputTokens = 480;
  assert.equal((await gateway.complete(a, request({ messages }))).status, 200);
  assert.equal(generations(backend).length, 1);
});

test("rejected and canceled token preflight preserve the previous session KV and its expiry", async t => {
  let now = 1000;
  const {gateway, backend, a, b} = fixture(t, {slots: 1, clock: () => now});
  await gateway.complete(a, request());
  const before = erases(backend).length;
  for (const httpStatus of [400, 422]) {
    backend.count = () => Response.json({error: "bad input"}, {status: httpStatus});
    await assert.rejects(gateway.complete(b, request()), status(httpStatus));
  }
  backend.count = null; backend.inputTokens = 481;
  await assert.rejects(gateway.complete(b, request()), status(422));
  assert.equal(erases(backend).length, before, "Invalid input must not evict another tenant's warm cache");
  const entered = deferred(), client = new AbortController();
  backend.count = (_body, {init}) => new Promise((_resolve, reject) => {
    entered.resolve(); init.signal.addEventListener("abort", () => reject(init.signal.reason), {once: true});
  });
  const canceled = assert.rejects(gateway.complete(a, request(), client.signal), status(503));
  await entered.promise; client.abort(); await canceled;
  assert.equal(erases(backend).length, before);
  backend.count = null; backend.inputTokens = 40;
  now = 2000;
  await gateway.complete(a, request());
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
  now = 301000; backend.inputTokens = 481;
  await assert.rejects(gateway.complete(a, request()), status(422));
  now = 302000; backend.inputTokens = 40;
  await gateway.complete(a, request());
  assert.equal(generations(backend).at(-1).body.cache_prompt, false, "Rejected requests cannot renew cache affinity");
  assert.equal(erases(backend).length, before + 1);
});

test("an acknowledged empty slot is not erased twice and sessionless output still needs cleanup", async t => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  await gateway.complete(a, request({session_id: undefined}));
  assert.equal(erases(backend).length, 1, "Initial preparation's erase ACK already proved the slot empty");
  await gateway.complete(a, request({session_id: "new"}));
  assert.equal(erases(backend).length, 2, "No cache owner does not mean a sessionless generation left empty KV");
  backend.chat = () => Response.json({}, {status: 503});
  await assert.rejects(gateway.complete(a, request({session_id: "new"})), status(503));
  const erased = erases(backend).length;
  backend.chat = null;
  await gateway.complete(a, request({session_id: "after-failure"}));
  assert.equal(erases(backend).length, erased, "Failure cleanup's ACK can be reused for admission");
  assert.equal(generations(backend).at(-1).body.cache_prompt, false);
});

test("backend template, context and slot mismatches stop admission before token preflight", async (t) => {
  for (const change of [
    (props) => { props.chat_template = "different template"; },
    (props) => { props.total_slots = 3; },
    (props) => { props.default_generation_settings.n_ctx = 1024; },
  ]) {
    const { gateway, backend, a } = fixture(t);
    change(backend.props);
    await assert.rejects(gateway.complete(a, request()), status(503));
    assert.equal(generations(backend).length, 0);
    assert.equal(backend.calls.some((call) => call.path.endsWith("input_tokens")), false);
    assert.equal(gateway.snapshot().groups[0].status, "unavailable");
  }
});

test("same-session warm cache is reused but an ownership change requires acknowledged erasure", async (t) => {
  let now = 1;
  const { gateway, backend, a, b } = fixture(t, { slots: 1, clock: () => now });
  await gateway.complete(a, request());
  const firstErases = erases(backend).length;
  now++;
  await gateway.complete(a, request({ messages: [
    { role: "user", content: "hello" }, { role: "assistant", content: "hello back" }, { role: "user", content: "more" },
  ] }));
  assert.equal(erases(backend).length, firstErases);
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
  now++;
  await gateway.complete(b, request());
  assert.equal(erases(backend).length, firstErases + 1);
  assert.equal(generations(backend).at(-1).body.cache_prompt, false);
  const calls = backend.calls;
  const lastChat = calls.findLastIndex((call) => call.path === "/v1/chat/completions");
  const lastErase = calls.findLastIndex((call) => /^\/slots\/\d+$/.test(call.path));
  assert.ok(lastErase < lastChat);
});

test("aborted generation keeps its slot reserved until erase acknowledges cancellation", async (t) => {
  const { gateway, backend, a, b } = fixture(t, { slots: 1 });
  await gateway.complete(a, request({ session_id: "warmup" }));
  let entered = false, erasing = false;
  const eraseGate = deferred();
  backend.chat = (_body, { init }) => new Promise((_resolve, reject) => {
    entered = true;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  backend.erase = async (id) => {
    if (entered) { erasing = true; await eraseGate.promise; }
    return Response.json({ id_slot: id, n_erased: 40 });
  };
  const controller = new AbortController();
  const first = gateway.complete(a, request(), controller.signal);
  const failure = assert.rejects(first, status(503));
  await until(() => entered);
  controller.abort();
  await until(() => erasing);
  assert.equal(gateway.snapshot().groups[0].active, 1);
  const before = generations(backend).length;
  await assert.rejects(gateway.complete(b, request()), (error) => [429, 503].includes(error.status));
  assert.equal(generations(backend).length, before);
  eraseGate.resolve();
  await failure;
  assert.equal(gateway.snapshot().groups[0].active, 0);
});

test("failed cancellation quarantines the group until every backend slot reports idle", async (t) => {
  const { gateway, backend, a, b } = fixture(t, { slots: 1 });
  await gateway.complete(a, request({ session_id: "warmup" }));
  let entered = false;
  backend.chat = (body, { init }) => new Promise((_resolve, reject) => {
    entered = true; backend.processing[body.id_slot] = true;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const controller = new AbortController();
  const first = gateway.complete(a, request(), controller.signal);
  const failure = assert.rejects(first, status(503));
  await until(() => entered);
  const originalEpoch = gateway.snapshot().groups[0].epoch;
  controller.abort(); await failure;
  assert.equal(gateway.snapshot().groups[0].status, "unavailable");
  assert.notEqual(gateway.snapshot().groups[0].epoch, originalEpoch);
  const before = generations(backend).length;
  await assert.rejects(gateway.complete(b, request()), status(503));
  assert.equal(generations(backend).length, before);
  backend.processing[0] = false;
  backend.chat = () => result();
  assert.equal((await gateway.complete(b, request())).status, 200);
  assert.equal(gateway.snapshot().groups[0].status, "ready");
  assert.equal(generations(backend).at(-1).body.cache_prompt, false);
});

function sse(chunks, onCancel) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
    cancel() { onCancel?.(); },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
}

test("SSE completion forwards split DONE markers and frees capacity only after stream completion", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  backend.chat = () => sse(['data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":"stop"}]}\r\n\r\n', "data: [DO", "NE]\r\n\r\n"]);
  const response = await gateway.complete(a, request({ stream: true }));
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-relay-group"), "lan-group");
  assert.equal(gateway.snapshot().groups[0].active, 1);
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(gateway.snapshot().groups[0].active, 0);
  assert.equal(gateway.snapshot().groups[0].requests, 1);
});

test("an abruptly ended SSE stream fails and erases the cached partial generation", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  backend.chat = () => sse(['data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n']);
  const response = await gateway.complete(a, request({ stream: true }));
  const initialErases = erases(backend).length;
  await assert.rejects(response.text(), /without \[DONE\]/);
  assert.equal(erases(backend).length, initialErases + 1);
  assert.equal(gateway.snapshot().groups[0].active, 0);
  assert.equal(gateway.snapshot().groups[0].requests, 0);
  assert.equal(gateway.snapshot().groups[0].failures, 1);
});

test("SSE proxy respects consumer backpressure and cancellation erases before returning capacity", async (t) => {
  const { gateway, backend, a, b } = fixture(t, { slots: 1 });
  let pulls = 0, canceled = false;
  backend.chat = () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n')); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
  const response = await gateway.complete(a, request({ stream: true }));
  await tick(); await tick();
  assert.ok(pulls <= 1, `The proxy eagerly drained ${pulls} chunks without a consumer.`);
  const eraseGate = deferred();
  let erasing = false;
  backend.erase = async (id) => {
    erasing = true; await eraseGate.promise; return Response.json({ id_slot: id, n_erased: 40 });
  };
  const cancellation = response.body.cancel();
  await until(() => erasing);
  assert.equal(canceled, true);
  assert.equal(gateway.snapshot().groups[0].active, 1);
  await assert.rejects(gateway.complete(b, request()), (error) => [429, 503].includes(error.status));
  eraseGate.resolve(); await cancellation;
  assert.equal(gateway.snapshot().groups[0].active, 0);
});

test("client abort cleans up an unread SSE response without requiring another consumer pull", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  let pulls = 0, canceled = false;
  backend.chat = () => new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n'));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
  const client = new AbortController();
  const response = await gateway.complete(a, request({ stream: true }), client.signal);
  t.after(() => response.body.cancel().catch(() => {}));
  await until(() => pulls === 1);
  const before = erases(backend).length;
  client.abort();
  await until(() => gateway.snapshot().groups[0].active === 0);
  assert.equal(canceled, true);
  assert.equal(erases(backend).length, before + 1);
  assert.equal(gateway.snapshot().groups[0].failures, 1);
});
test("retry receipts return completed bytes once and isolate tenant and request fingerprints", async (t) => {
  const { gateway, backend, a, b } = fixture(t, { slots: 2 });
  const key = "request-key-000001";
  const gate = deferred();
  let entered = false;
  backend.chat = () => { entered = true; return gate.promise; };
  const input = request();
  const first = gateway.complete(a, input, undefined, key);
  await until(() => entered);
  await assert.rejects(gateway.complete(a, input, undefined, key), status(409));
  gate.resolve(result());
  const firstBytes = await (await first).text();
  const duplicate = await gateway.complete(a, input, undefined, key);
  assert.equal(duplicate.headers.get("x-relay-duplicate"), "true");
  assert.equal(await duplicate.text(), firstBytes);
  assert.equal(generations(backend).length, 1);
  await assert.rejects(gateway.complete(a, request({ max_tokens: 33 }), undefined, key), status(409));
  backend.chat = () => result();
  assert.equal((await gateway.complete(b, input, undefined, key)).status, 200);
  assert.equal(generations(backend).length, 2);
});

test("an uncertain generation keeps its retry fence while a preflight rejection can be retried", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  const input = request(), uncertainKey = "request-key-unknown";
  backend.chat = () => { throw Error("upstream disconnected after accepting input"); };
  await assert.rejects(gateway.complete(a, input, undefined, uncertainKey), status(503));
  const callCount = backend.calls.length;
  await assert.rejects(gateway.complete(a, input, undefined, uncertainKey), status(409));
  assert.equal(backend.calls.length, callCount);
  backend.chat = () => result();
  backend.inputTokens = 481;
  const validationKey = "request-key-preflight";
  await assert.rejects(gateway.complete(a, input, undefined, validationKey), status(422));
  backend.inputTokens = 40;
  assert.equal((await gateway.complete(a, input, undefined, validationKey)).status, 200);
  await assert.rejects(gateway.complete(a, request({ stream: true }), undefined, "stream-retry-key01"), status(400));
});

test("receipt count expires per tenant and validation failures do not consume capacity", async t => {
  let now = 1000;
  const {gateway, backend, a, b} = fixture(t, {clock: () => now});
  backend.inputTokens = 512;
  for (let i = 0; i < 260; i++) await assert.rejects(gateway.complete(a, request(), undefined, `invalid-request-${String(i).padStart(4, "0")}`), status(422));
  backend.inputTokens = 40;
  for (let i = 0; i < 256; i++) await gateway.complete(a, request(), undefined, `cached-request-${String(i).padStart(4, "0")}`);
  await assert.rejects(gateway.complete(a, request(), undefined, "cached-request-overflow"), status(429));
  assert.equal((await gateway.complete(b, request(), undefined, "cached-request-other")).status, 200);
  now += 600000;
  assert.equal((await gateway.complete(a, request(), undefined, "cached-request-overflow")).status, 200);
});

test("receipt byte budget reclaims expired storage while retaining uncached retry fences", async t => {
  let now = 1000;
  const {gateway, backend, a} = fixture(t, {slots: 1, clock: () => now});
  backend.chat = () => Response.json({choices: [{message: {role: "assistant", content: "x".repeat(3 * 1024 * 1024)}, finish_reason: "stop"}]});
  for (const suffix of ["first", "second", "uncached"]) {
    await (await gateway.complete(a, request(), undefined, `large-receipt-${suffix}`)).body.cancel();
    now += 1000;
  }
  const duplicate = await gateway.complete(a, request(), undefined, "large-receipt-first");
  assert.equal(duplicate.headers.get("x-relay-duplicate"), "true");
  await duplicate.body.cancel();
  await assert.rejects(gateway.complete(a, request(), undefined, "large-receipt-uncached"), status(409));
  now = 601000;
  await (await gateway.complete(a, request(), undefined, "large-receipt-after-expiry")).body.cancel();
  const restoredBudget = await gateway.complete(a, request(), undefined, "large-receipt-after-expiry");
  assert.equal(restoredBudget.headers.get("x-relay-duplicate"), "true");
  await restoredBudget.body.cancel();
  await assert.rejects(gateway.complete(a, request(), undefined, "large-receipt-uncached"), status(409));
});

test("closing with pending retry receipts cannot repopulate the response cache", async t => {
  const {gateway, backend, a} = fixture(t, {slots: 1}), gate = deferred();
  backend.chat = () => gate.promise;
  const pending = gateway.complete(a, request(), undefined, "close-pending-receipt");
  await until(() => generations(backend).length === 1);
  const failed = assert.rejects(pending, status(503));
  gateway.close(); gate.resolve(result()); await failed;
  await assert.rejects(gateway.complete(a, request(), undefined, "close-pending-receipt"), status(503));
  await assert.rejects(gateway.complete(a, request(), undefined, "close-pending-receipt"), status(503), "A closed request must not recreate a retry fence.");
  assert.equal(generations(backend).length, 1);
});

test("request timeout reclaims an unread SSE stream independently of consumer backpressure", async (t) => {
  const settings = config(1);
  settings.requestTimeoutMs = 1000;
  const { gateway, backend, a } = fixture(t, { config: settings });
  const canceled = deferred();
  backend.chat = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n')); },
    cancel() { canceled.resolve(); },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
  const response = await gateway.complete(a, request({ stream: true }));
  t.after(() => response.body.cancel().catch(() => {}));
  let timer;
  try {
    await Promise.race([
      canceled.promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("Timeout did not cancel unread backend stream.")), 2500); }),
    ]);
  } finally { clearTimeout(timer); }
  await until(() => gateway.snapshot().groups[0].active === 0);
  assert.equal(gateway.snapshot().groups[0].failures, 1);
});
test("reasoning-only assistant responses round-trip unchanged through token preflight and generation", async (t) => {
  const { gateway, backend, a } = fixture(t, { slots: 1 });
  const assistant = { role: "assistant", content: null, reasoning_content: "A model-produced reasoning field." };
  backend.chat = () => Response.json({ choices: [{ index: 0, message: assistant, finish_reason: "length" }] });
  const first = await (await gateway.complete(a, request())).json();
  assert.deepEqual(first.choices[0].message, assistant);
  const messages = [
    { role: "user", content: "hello" }, first.choices[0].message,
    { role: "user", content: "continue with the answer" },
  ];
  backend.chat = () => result();
  assert.equal((await gateway.complete(a, request({ messages }))).status, 200);
  const count = backend.calls.findLast((call) => call.path.endsWith("input_tokens"));
  assert.deepEqual(count.body.messages, messages);
  assert.deepEqual(generations(backend).at(-1).body.messages, messages);
  assert.throws(() => inferenceBody(request({ messages: [{ role: "user", content: "hello", reasoning_content: "invalid role" }] })), status(400));
  assert.throws(() => inferenceBody(request({ messages: [{ role: "assistant", content: "answer", reasoning_content: {} }] })), status(400));
});

test("one tenant's backend request error does not abort another tenant's active slot", async (t) => {
  const { gateway, backend, a, b } = fixture(t);
  const gate = deferred();
  let otherSignal;
  backend.chat = (body, { init }) => {
    if (body.messages[0].content === "bad-schema") return Response.json({ error: "invalid sampler request" }, { status: 400 });
    otherSignal = init.signal;
    backend.processing[body.id_slot] = true;
    init.signal.addEventListener("abort", () => gate.reject(init.signal.reason), { once: true });
    return gate.promise.finally(() => { backend.processing[body.id_slot] = false; });
  };
  const other = gateway.complete(b, request()).then((response) => ({ response }), (error) => ({ error }));
  await until(() => otherSignal !== undefined);
  const epoch = gateway.snapshot().groups[0].epoch;
  await assert.rejects(gateway.complete(a, request({ messages: [{ role: "user", content: "bad-schema" }] })), status(400));
  assert.equal(otherSignal.aborted, false);
  assert.equal(gateway.snapshot().groups[0].active, 1);
  assert.equal(gateway.snapshot().groups[0].status, "ready");
  assert.equal(gateway.snapshot().groups[0].epoch, epoch);
  gate.resolve(result());
  const outcome = await other;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.response.status, 200);
  assert.equal(gateway.snapshot().groups[0].active, 0);
});
test("canceling one nonstream request preserves another tenant's healthy generation", async (t) => {
  const { gateway, backend, a, b } = fixture(t);
  const active = new Map();
  backend.chat = (body, { init }) => {
    const gate = deferred();
    active.set(body.messages[0].content, { gate, signal: init.signal });
    backend.processing[body.id_slot] = true;
    init.signal.addEventListener("abort", () => {
      backend.processing[body.id_slot] = false;
      gate.reject(init.signal.reason);
    }, { once: true });
    return gate.promise.finally(() => { backend.processing[body.id_slot] = false; });
  };
  const client = new AbortController();
  const canceled = gateway.complete(a, request({ messages: [{ role: "user", content: "cancel-me" }] }), client.signal);
  const cancellation = assert.rejects(canceled, status(503));
  await until(() => active.has("cancel-me"));
  const other = gateway.complete(b, request()).then((response) => ({ response }), (error) => ({ error }));
  await until(() => active.has("hello"));
  const epoch = gateway.snapshot().groups[0].epoch;
  const before = erases(backend).length;
  client.abort();
  await cancellation;
  assert.equal(erases(backend).length, before + 1);
  assert.equal(active.get("hello").signal.aborted, false);
  assert.equal(gateway.snapshot().groups[0].active, 1);
  assert.equal(gateway.snapshot().groups[0].status, "ready");
  assert.equal(gateway.snapshot().groups[0].epoch, epoch);
  active.get("hello").gate.resolve(result());
  const outcome = await other;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.response.status, 200);
  assert.equal(gateway.snapshot().groups[0].active, 0);
});
test("closing the gateway rejects future work without touching its backend", async (t) => {
  const { gateway, backend, a } = fixture(t);
  gateway.close();
  await assert.rejects(gateway.complete(a, request()), status(503));
  assert.equal(backend.calls.length, 0);
});






test("JSON completions validate assistant content and matching tool finish reasons before caching", async (t) => {
  const invalid = [
    {message: {}, finish_reason: "stop"},
    {message: {role: "user", content: "answer"}, finish_reason: "stop"},
    {message: {role: "assistant"}, finish_reason: "stop"},
    {message: {role: "assistant", content: {text: "answer"}}, finish_reason: "stop"},
    {message: {role: "assistant", reasoning_content: 10}, finish_reason: "length"},
    {message: {role: "assistant", content: "answer"}, finish_reason: "tool_calls"},
    {message: {role: "assistant", tool_calls: [{id: "bad", type: "function", function: {name: "weather"}}]}, finish_reason: "tool_calls"},
    {index: 1, message: {role: "assistant", content: "answer"}, finish_reason: "stop"},
  ];
  const {gateway, backend, a} = fixture(t, {slots: 1});
  for (let i = 0; i < invalid.length; i++) {
    backend.chat = () => Response.json({choices: [invalid[i]]});
    const key = `invalid-response-${i}`;
    const before = erases(backend).length;
    await assert.rejects(gateway.complete(a, request(), undefined, key), status(503));
    assert.ok(erases(backend).length > before, "Invalid output must erase its KV.");
    const count = generations(backend).length;
    await assert.rejects(gateway.complete(a, request(), undefined, key), status(409));
    assert.equal(generations(backend).length, count, "Invalid results must not become successful retry receipts.");
    assert.equal(gateway.snapshot().groups[0].active, 0);
  }
  assert.equal(gateway.snapshot().groups[0].requests, 0);
  assert.equal(gateway.snapshot().groups[0].failures, invalid.length);
  const message = {role: "assistant", content: null, tool_calls: [
    {id: "call_weather", type: "function", function: {name: "weather", arguments: '{"city":"Seoul"}'}},
  ]};
  backend.chat = () => Response.json({choices: [{index: 0, message, finish_reason: "tool_calls"}]});
  assert.deepEqual((await (await gateway.complete(a, request())).json()).choices[0].message, message);
  assert.equal(gateway.snapshot().groups[0].requests, 1);
});

const event = (delta, finish_reason = null) => ({choices: [{index: 0, delta, finish_reason}]});
const eventData = value => `data: ${JSON.stringify(value)}\n\n`;

test("attempt timings use a monotonic clock and wait for semantic SSE output", async t => {
  let now = 0;
  const {gateway, backend, a} = fixture(t, {slots: 1, clock: () => 9000, monotonicClock: () => now});
  assert.equal(gateway.snapshot().groups[0].lastAttempt, null);
  backend.health = () => { now += 5; return Response.json({status: "ok"}); };
  backend.erase = id => { now += 3; return Response.json({id_slot: id, n_erased: 0}); };
  backend.count = () => { now += 7; return Response.json({input_tokens: 40}); };
  const chunks = [
    [3, ": keepalive\n\n"],
    [4, eventData(event({role: "assistant", content: ""}))],
    [11, eventData(event({content: "answer"}))],
    [8, eventData(event({}, "stop")) + eventData({choices: [], usage: {completion_tokens: 3}}) + "data: [DONE]\n\n"],
  ];
  backend.chat = () => {
    now += 2;
    return new Response(new ReadableStream({
      pull(output) {
        const chunk = chunks.shift();
        if (chunk) { now += chunk[0]; output.enqueue(new TextEncoder().encode(chunk[1])); }
        else { now += 2; output.close(); }
      },
    }, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  };
  await (await gateway.complete(a, request({stream: true}))).text();
  const group = gateway.snapshot().groups[0];
  assert.deepEqual(group.lastAttempt, {outcome: "success", prepareMs: 8, inputValidationMs: 7,
    kvEraseMs: null, backendFirstOutputMs: 20, backendTotalMs: 30, cleanupMs: null, totalMs: 45});
  assert.ok(Object.isFrozen(group.lastAttempt));
  assert.equal(group.generationMs, 0, "The existing wall-clock counter keeps its previous semantics.");
  assert.equal(group.outputTokens, 3);
});

test("JSON attempt timings expose KV eviction without inventing first-output latency", async t => {
  let now = 0;
  const {gateway, backend, a} = fixture(t, {slots: 1, monotonicClock: () => now});
  await gateway.complete(a, request());
  const previous = gateway.snapshot().groups[0].lastAttempt;
  backend.health = () => { now += 2; return Response.json({status: "ok"}); };
  backend.count = () => { now += 3; return Response.json({input_tokens: 40}); };
  backend.erase = id => { now += 5; return Response.json({id_slot: id, n_erased: 40}); };
  backend.chat = () => { now += 11; return result(); };
  await gateway.complete(a, request({session_id: "new-session"}));
  assert.deepEqual(gateway.snapshot().groups[0].lastAttempt, {outcome: "success", prepareMs: 2, inputValidationMs: 3,
    kvEraseMs: 5, backendFirstOutputMs: null, backendTotalMs: 11, cleanupMs: null, totalMs: 21});
  assert.equal(previous.totalMs, 0, "A later attempt replaces rather than mutates the bounded snapshot.");
  assert.equal(generations(backend).at(-1).body.cache_prompt, false);
});

test("failed attempt timings include cleanup only after its ACK and leave unreached phases null", async t => {
  let now = 0;
  const {gateway, backend, a} = fixture(t, {slots: 1, monotonicClock: () => now});
  await gateway.complete(a, request());
  const previous = gateway.snapshot().groups[0].lastAttempt, cleanup = deferred();
  backend.health = () => { now += 2; return Response.json({status: "ok"}); };
  backend.count = () => { now += 3; return Response.json({input_tokens: backend.inputTokens}); };
  backend.chat = () => { now += 7; throw Error("lost backend"); };
  let cleaning = false;
  backend.erase = async id => { cleaning = true; await cleanup.promise; now += 5; return Response.json({id_slot: id, n_erased: 40}); };
  const failed = assert.rejects(gateway.complete(a, request()), status(503));
  await until(() => cleaning);
  assert.equal(gateway.snapshot().groups[0].active, 1);
  assert.equal(gateway.snapshot().groups[0].lastAttempt, previous, "Only settled attempts become visible.");
  cleanup.resolve(); await failed;
  assert.deepEqual(gateway.snapshot().groups[0].lastAttempt, {outcome: "failure", prepareMs: 2, inputValidationMs: 3,
    kvEraseMs: null, backendFirstOutputMs: null, backendTotalMs: 7, cleanupMs: 5, totalMs: 17});
  assert.equal(gateway.snapshot().groups[0].active, 0);
  const erased = erases(backend).length;
  backend.inputTokens = 481;
  await assert.rejects(gateway.complete(a, request()), status(422));
  assert.deepEqual(gateway.snapshot().groups[0].lastAttempt, {outcome: "failure", prepareMs: 2, inputValidationMs: 3,
    kvEraseMs: null, backendFirstOutputMs: null, backendTotalMs: null, cleanupMs: null, totalMs: 5});
  assert.equal(erases(backend).length, erased, "Read-only input rejection must not trigger cleanup.");
});

test("SSE parsing preserves split UTF-8, CRLF, comments, multiline JSON and usage", async (t) => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  const payload = ': keepalive\r\nevent: message\r\ndata: {"choices": [\r\ndata\r\ndata: {"index":0,"delta":{"role":"assistant","content":"한글 👋"},"finish_reason":null}]}\r\n\r\n' +
    eventData(event({}, "stop")) + eventData({choices: [], usage: {completion_tokens: 3}}) + 'data:[DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(payload);
  let index = 0;
  backend.chat = () => new Response(new ReadableStream({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(index, ++index));
    },
  }, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  assert.equal(await (await gateway.complete(a, request({stream: true}))).text(), payload);
  assert.equal(gateway.snapshot().groups[0].requests, 1);
  assert.equal(gateway.snapshot().groups[0].outputTokens, 3, "Only validated, engine-reported SSE token usage is counted.");
  assert.equal(gateway.snapshot().groups[0].active, 0);
});

test("SSE preserves long fragmented lines and bare CR delimiters without retaining previous content", async t => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  const payload = eventData(event({role: "assistant", content: "가나다👋".repeat(32768)})).replaceAll("\n", "\r") +
    eventData(event({}, "stop")).replaceAll("\n", "\r") + "data: [DONE]\r\r";
  const bytes = new TextEncoder().encode(payload); let offset = 0;
  backend.chat = () => new Response(new ReadableStream({pull(output) {
    if (offset === bytes.length) output.close();
    else { const end = Math.min(bytes.length, offset + 257); output.enqueue(bytes.subarray(offset, end)); offset = end; }
  }}, {highWaterMark: 0}), {headers: {"Content-Type": "text/event-stream"}});
  assert.equal(await (await gateway.complete(a, request({stream: true}))).text(), payload);
  assert.equal(gateway.snapshot().groups[0].requests, 1);
});

test("SSE reasoning and fragmented function calls are accepted as complete assistant output", async (t) => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  const outputs = [
    [event({role: "assistant", content: null, reasoning_content: "reasoning only"}), event({}, "length")],
    [event({role: "assistant", tool_calls: [{index: 0, id: "call_1", type: "function", function: {name: "weather", arguments: '{"city":'}}]}),
      event({tool_calls: [{index: 0, function: {arguments: '"Seoul"}'}}]}), event({}, "tool_calls")],
  ];
  for (const output of outputs) {
    const payload = output.map(eventData).join("") + "data: [DONE]\n\n";
    backend.chat = () => sse([payload]);
    assert.equal(await (await gateway.complete(a, request({stream: true}))).text(), payload);
  }
  assert.equal(gateway.snapshot().groups[0].requests, 2);
  assert.equal(gateway.snapshot().groups[0].failures, 0);
});

test("SSE contract violations never count as success and release capacity after cleanup", async (t) => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  const valid = eventData(event({role: "assistant", content: "answer"}, "stop"));
  const invalid = [
    eventData({choices: []}),
    eventData(event({role: "user", content: "answer"}, "stop")),
    eventData(event({role: "assistant"}, "stop")),
    eventData({choices: [{index: 1, delta: {role: "assistant", content: "answer"}, finish_reason: "stop"}]}),
    eventData(event({role: "assistant", content: 42}, "stop")),
    eventData(event({role: "assistant", content: "answer"}, "tool_calls")),
    eventData(event({role: "assistant", tool_calls: [{index: 1, id: "call_1", type: "function", function: {name: "weather", arguments: "{}"}}]}, "tool_calls")),
    valid + eventData(event({}, "stop")),
    valid + "data: [DONE]\n\n" + eventData(event({content: "too late"})),
    "event: error\ndata: {}\n\n",
    'data: {"error":{"message":"failure"}}\n\n',
    "data:\n\n",
    "data\r\r",
  ];
  for (const payload of invalid) {
    backend.chat = () => sse([payload, "data: [DONE]\n\n"]);
    const response = await gateway.complete(a, request({stream: true}));
    await assert.rejects(response.text(), /Invalid inference stream/);
    assert.equal(gateway.snapshot().groups[0].active, 0);
    assert.equal(gateway.snapshot().groups[0].requests, 0);
  }
  assert.equal(gateway.snapshot().groups[0].failures, invalid.length);
  backend.chat = () => sse([valid, "data: [DONE]\n"]);
  await assert.rejects((await gateway.complete(a, request({stream: true}))).text(), /Invalid inference stream/);
});

for (const warmed of [false, true]) {
  test(`canceling a ${warmed ? "ready verification" : "shared initial preparation"} wait preserves another tenant`, async (t) => {
    const {gateway, backend, a, b} = fixture(t);
    if (warmed) await gateway.complete(a, request({session_id: "warmup"}));
    const gate = deferred(), client = new AbortController(), signals = [];
    backend.health = async ({init}) => {
      signals.push(init.signal);
      await gate.promise;
      return Response.json({status: "ok"});
    };
    let outcome;
    const canceled = gateway.complete(a, request(), client.signal).then(
      response => { outcome = {response}; }, error => { outcome = {error}; });
    await until(() => signals.length > 0);
    const other = gateway.complete(b, request());
    await until(() => gateway.snapshot().groups[0].active === 2);
    const before = erases(backend).length;
    client.abort();
    await until(() => outcome !== undefined);
    assert.equal(outcome.error?.status, 503);
    assert.equal(gateway.snapshot().groups[0].active, 1);
    assert.equal(erases(backend).length, before, "The canceled preparation never used a backend slot.");
    assert.equal(signals.every(signal => !signal.aborted), true);
    gate.resolve();
    await canceled;
    assert.equal((await other).status, 200);
    assert.equal(gateway.snapshot().groups[0].status, "ready");
    assert.equal(gateway.snapshot().groups[0].active, 0);
    assert.equal(gateway.snapshot().groups[0].failures, 1);
    assert.equal(signals.length, 1, "Initial preparation and ready verification must both be shared.");
  });
}

test("canceling slot acquisition waits for its in-flight erase ACK without sending duplicate erases", async (t) => {
  const {gateway, backend, a, b} = fixture(t, {slots: 1});
  await gateway.complete(a, request({session_id: "warmup"}));
  const gate = deferred(), client = new AbortController();
  let erasing = false;
  backend.erase = async id => { erasing = true; await gate.promise; return Response.json({id_slot: id, n_erased: 1}); };
  const before = erases(backend).length, generated = generations(backend).length;
  const canceled = assert.rejects(gateway.complete(a, request(), client.signal), status(503));
  await until(() => erasing);
  client.abort(); await tick();
  assert.equal(gateway.snapshot().groups[0].active, 1);
  await assert.rejects(gateway.complete(b, request()), status(429));
  gate.resolve(); await canceled;
  assert.equal(erases(backend).length, before + 1);
  assert.equal(generations(backend).length, generated);
  assert.equal(gateway.snapshot().groups[0].active, 0);
  assert.equal(gateway.snapshot().groups[0].status, "ready");
});


test("explicit empty text remains a valid completion while role-only output is rejected", async (t) => {
  const {gateway, backend, a} = fixture(t, {slots: 1});
  for (const message of [{role: "assistant", content: ""}, {role: "assistant", content: null, reasoning_content: ""}]) {
    backend.chat = () => Response.json({choices: [{message, finish_reason: "stop"}]});
    assert.deepEqual((await (await gateway.complete(a, request())).json()).choices[0].message, message);
    const payload = eventData(event(message, "stop")) + "data: [DONE]\n\n";
    backend.chat = () => sse([payload]);
    assert.equal(await (await gateway.complete(a, request({stream: true}))).text(), payload);
  }
  assert.equal(gateway.snapshot().groups[0].requests, 4);
  assert.equal(gateway.snapshot().groups[0].failures, 0);
});


test("invalid SSE termination waits for the same erase ACK as its abort handler", async (t) => {
  const {gateway, backend, a, b} = fixture(t, {slots: 1});
  backend.chat = () => sse([eventData(event({role: "assistant", content: "partial"})), "data: broken JSON\n\n"]);
  const response = await gateway.complete(a, request({stream: true}));
  const gate = deferred();
  let erasing = false, settled = false;
  backend.erase = async id => { erasing = true; await gate.promise; return Response.json({id_slot: id, n_erased: 1}); };
  const consumed = response.text().finally(() => { settled = true; });
  const failure = assert.rejects(consumed, /Invalid inference stream/);
  await until(() => erasing);
  await tick();
  assert.equal(settled, false, "Stream errors must wait for cancellation cleanup to finish.");
  assert.equal(gateway.snapshot().groups[0].active, 1);
  await assert.rejects(gateway.complete(b, request()), status(429));
  gate.resolve(); await failure;
  assert.equal(gateway.snapshot().groups[0].active, 0);
  assert.equal(gateway.snapshot().groups[0].failures, 1);
});

test("concurrent ready checks share one verification without erasing either warm session", async t => {
  const {gateway, backend, a, b} = fixture(t);
  await gateway.complete(a, request());
  await gateway.complete(b, request());
  const gate = deferred();
  let checks = 0;
  backend.health = async () => { checks++; await gate.promise; return Response.json({status: "ok"}); };
  const before = erases(backend).length;
  const first = gateway.complete(a, request()), second = gateway.complete(b, request());
  await until(() => checks > 0 && gateway.snapshot().groups[0].active === 2);
  assert.equal(checks, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(checks, 1);
  assert.equal(erases(backend).length, before);
  assert.ok(generations(backend).slice(-2).every(call => call.body.cache_prompt));
});

test("a stale shared health check cannot invalidate or erase a newer provider epoch", async t => {
  for (const warmed of [false, true]) {
    const settings = config(1), key = "p".repeat(48);
    for (const gpu of settings.groups[0].gpus) gpu.providerKeySha256 = hash(key);
    const {gateway, backend, a} = fixture(t, {config: settings});
    if (warmed) await gateway.complete(a, request());
    const gate = deferred();
    let entered = false;
    backend.health = async () => { entered = true; await gate.promise; return Response.json({status: "ok"}); };
    const old = assert.rejects(gateway.complete(a, request()), status(503));
    await until(() => entered);
    gateway.providerEvent("Bearer " + key, {groupId: "lan-group", gpuIds: ["a/GPU-1", "b/GPU-1"],
      runtimeId: "new-runtime", startedAt: 100, state: "providing"});
    await old;
    const epoch = gateway.snapshot().groups[0].epoch, erased = erases(backend).length;
    backend.health = null;
    const waiting = assert.rejects(gateway.complete(a, request()), status(503));
    await until(() => gateway.snapshot().groups[0].active === 1);
    gate.resolve(); await waiting;
    assert.equal(gateway.snapshot().groups[0].epoch, epoch, "The obsolete check must not invalidate the new runtime.");
    assert.equal(erases(backend).length, erased, "The obsolete check must not erase slots from the new runtime.");
    assert.equal((await gateway.complete(a, request())).status, 200);
    assert.equal(gateway.snapshot().groups[0].status, "ready");
    assert.equal(gateway.snapshot().groups[0].epoch, epoch);
  }
});

test("the same tenant session can run different models concurrently", async t => {
  const settings = config(1), second = structuredClone(settings.groups[0]);
  second.id = "second-model"; second.model = "qwen-other"; second.endpoint = "http://127.0.0.1:8082";
  second.gpus = second.gpus.map(gpu => ({...gpu, id: "second/" + gpu.id}));
  settings.groups.push(second);
  settings.tenants[1].models.push(second.model);
  const {gateway, backend, b} = fixture(t, {config: settings});
  const gate = deferred();
  backend.chat = (_, call) => call.origin.endsWith(":8081") ? gate.promise : result();
  const first = gateway.complete(b, request());
  try {
    await until(() => generations(backend).length === 1);
    const other = await gateway.complete(b, request({model: second.model}));
    assert.equal(other.headers.get("x-relay-group"), second.id);
    assert.equal(generations(backend).at(-1).body.cache_prompt, false);
    await assert.rejects(gateway.complete(b, request()), status(409), "Same-model overlap must still be rejected");
  } finally { gate.resolve(result()); await first; }
});

test("new sessions use a cleared ready group before evicting another group's warm KV", async t => {
  const settings = config(1), second = structuredClone(settings.groups[0]);
  second.id = "second"; second.endpoint = "http://127.0.0.1:8082";
  second.gpus = second.gpus.map(gpu => ({...gpu, id: "second/" + gpu.id}));
  settings.groups.push(second);
  let now = 1000;
  const {gateway, backend, b} = fixture(t, {config: settings, clock: () => now});
  const gate = deferred();
  backend.chat = (_, call) => call.origin.endsWith(":8081") ? gate.promise : result();
  const first = gateway.complete(b, request({session_id: "warm-first"}));
  try {
    await until(() => generations(backend).length === 1);
    await gateway.complete(b, request({session_id: "clear-second"}));
  } finally { now = 2000; gate.resolve(result()); await first; }
  now = 3000;
  backend.chat = () => Response.json({}, {status: 503});
  await assert.rejects(gateway.complete(b, request({session_id: "clear-second"})), status(503));
  assert.ok(gateway.snapshot().groups.every(group => group.status === "ready" && group.active === 0));
  backend.chat = null; now = 4000;
  const next = await gateway.complete(b, request({session_id: "new-session"}));
  assert.equal(next.headers.get("x-relay-group"), "second", "An empty slot should preserve another group's unexpired session");
  const resumed = await gateway.complete(b, request({session_id: "warm-first"}));
  assert.equal(resumed.headers.get("x-relay-group"), "lan-group");
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
});

test("new sessions use a cleared slot before evicting older warm KV within a group", async t => {
  let now = 1000;
  const {gateway, backend, b} = fixture(t, {slots: 2, clock: () => now});
  await gateway.complete(b, request({session_id: "warm-first"}));
  now = 2000;
  await gateway.complete(b, request({session_id: "clear-second"}));
  assert.equal(generations(backend).at(-1).body.id_slot, 1);
  now = 3000;
  backend.chat = () => Response.json({}, {status: 503});
  await assert.rejects(gateway.complete(b, request({session_id: "clear-second"})), status(503));
  backend.chat = null; now = 4000;
  await gateway.complete(b, request({session_id: "new-session"}));
  assert.equal(generations(backend).at(-1).body.id_slot, 1, "A recently cleared slot must be preferred over an older warm slot");
  await gateway.complete(b, request({session_id: "warm-first"}));
  assert.equal(generations(backend).at(-1).body.id_slot, 0);
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
});

test("sessionless completions leave disposable slots instead of displacing reusable KV", async t => {
  let now = 1000;
  const {gateway, backend, b} = fixture(t, {slots: 2, clock: () => now});
  await gateway.complete(b, request({session_id: "keep-warm"}));
  now = 2000;
  await gateway.complete(b, request({session_id: undefined}));
  assert.equal(generations(backend).at(-1).body.id_slot, 1);
  now = 3000;
  await gateway.complete(b, request({session_id: undefined}));
  assert.equal(generations(backend).at(-1).body.id_slot, 1);
  assert.equal(generations(backend).at(-1).body.cache_prompt, false);
  await gateway.complete(b, request({session_id: "keep-warm"}));
  assert.equal(generations(backend).at(-1).body.id_slot, 0);
  assert.equal(generations(backend).at(-1).body.cache_prompt, true);
});
