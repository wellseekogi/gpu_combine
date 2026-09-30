// Regression acceptance tests for the documented inference audit findings.
// Included in npm test; standalone command: node --test tests/audit-inference.test.mjs
// No real model, keys, .relay state, or network connection is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInferenceGateway } from "../lib/relay/inference.mjs";

const template = "audit synthetic template";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = extra => ({ model: "audit-model", session_id: "audit-session", messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...extra });

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t, options = {}) {
  const backend = { calls: [], health: null, chat: null, eraseCalls: 0 };
  const config = {
    version: 1, requestTimeoutMs: options.requestTimeoutMs ?? 10000,
    groups: [{ id: "audit-group", model: "audit-model", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: "http://127.0.0.1:8081", modelSha256: "a".repeat(64), templateSha256: sha256(template),
      slots: 1, contextTokens: 512, modelArchitecture: { layers: 1, kvHeads: 1, headDim: 64, kvBytes: 2 },
      gpus: [{ id: "synthetic/GPU-1", layers: 1, vramMiB: 1024, weightsMiB: 100, workspaceMiB: 100, reserveMiB: 100 }] }],
  };
  const gateway = createInferenceGateway(config, { fetchImpl: async (url, init) => {
    init.signal.throwIfAborted();
    const path = new URL(url).pathname;
    backend.calls.push({ path, signal: init.signal });
    if (path === "/health") return backend.health ? backend.health(init.signal) : Response.json({ status: "ok" });
    if (path === "/props") return Response.json({ total_slots: 1, default_generation_settings: { n_ctx: 512 }, chat_template: template });
    if (path === "/v1/models") return Response.json({ data: [{ id: "audit-model" }] });
    if (path === "/slots") return Response.json([{ id: 0, is_processing: false }]);
    if (path === "/slots/0") { backend.eraseCalls++; return Response.json({ id_slot: 0, n_erased: 0 }); }
    if (path.endsWith("/input_tokens")) return Response.json({ input_tokens: 8 });
    if (path === "/v1/chat/completions") return backend.chat ? backend.chat() : Response.json({ choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] });
    throw Error(`Unexpected audit mock path: ${path}`);
  } });
  t.after(() => gateway.close());
  return { gateway, backend, tenant: gateway.operator };
}

test("audit control: valid JSON completes and returns its reservation", async t => {
  const { gateway, tenant } = fixture(t);
  const result = await gateway.complete(tenant, input());
  assert.equal((await result.json()).choices[0].message.content, "answer");
  assert.equal(gateway.snapshot().groups[0].requests, 1);
  assert.equal(gateway.snapshot().groups[0].active, 0);
});

for (const [name, data] of [
  ["upstream error", '{"error":{"message":"GPU execution failed","type":"server_error"}}'],
  ["malformed JSON", "this is not JSON"],
  ["missing final choice", '{"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}'],
]) {
  test(`audit SSE acceptance: reject ${name} even when followed by DONE`, async t => {
    const { gateway, backend, tenant } = fixture(t);
    backend.chat = () => new Response(`data: ${data}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    const response = await gateway.complete(tenant, input({ stream: true }));
    const consumed = response.text();
    await consumed.then(() => t.diagnostic(`Invalid SSE returned HTTP ${response.status}; requests=${gateway.snapshot().groups[0].requests}; failures=${gateway.snapshot().groups[0].failures}`), () => {});
    await assert.rejects(consumed, undefined, "Invalid engine streams must not be reported as completed responses.");
    assert.equal(gateway.snapshot().groups[0].requests, 0);
    assert.equal(gateway.snapshot().groups[0].failures, 1);
  });
}

test("audit JSON acceptance: reject an empty assistant message object", async t => {
  const { gateway, backend, tenant } = fixture(t);
  backend.chat = () => Response.json({ choices: [{ message: {}, finish_reason: "stop" }] });
  const completion = gateway.complete(tenant, input());
  await completion.then(response => t.diagnostic(`Invalid JSON returned HTTP ${response.status}; requests=${gateway.snapshot().groups[0].requests}; failures=${gateway.snapshot().groups[0].failures}`), () => {});
  await assert.rejects(completion, error => error.status === 503);
  assert.equal(gateway.snapshot().groups[0].requests, 0);
});

test("audit cancellation: end the canceled request's wait during preparation", async t => {
  const { gateway, backend, tenant } = fixture(t);
  const entered = deferred(), release = deferred(), client = new AbortController();
  let observedSignal;
  backend.health = async signal => {
    observedSignal = signal;
    entered.resolve();
    await Promise.race([release.promise, new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    return Response.json({ status: "ok" });
  };
  let outcome;
  const request = gateway.complete(tenant, input(), client.signal).then(response => ({ response }), error => ({ error })).then(result => { outcome = result; return result; });
  await entered.promise;
  try {
    client.abort();
    await sleep(20);
    t.diagnostic(`After cancellation: requestSettled=${!!outcome}; healthAborted=${observedSignal.aborted}; active=${gateway.snapshot().groups[0].active}`);
    // Shared preparation may legitimately continue for another request.
    assert.ok(outcome?.error, "Client cancellation must end this request preparation wait.");
    assert.equal(gateway.snapshot().groups[0].active, 0, "Mock cleanup acknowledges immediately, so the canceled reservation must be released.");
  } finally {
    release.resolve();
    await request;
  }
});

test("audit timeout: configured deadline ends the request's preparation wait", async t => {
  const { gateway, backend, tenant } = fixture(t, { requestTimeoutMs: 1000 });
  const entered = deferred(), release = deferred();
  let observedSignal;
  backend.health = async signal => {
    observedSignal = signal;
    entered.resolve();
    await Promise.race([release.promise, new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    return Response.json({ status: "ok" });
  };
  let outcome;
  const request = gateway.complete(tenant, input()).then(response => ({ response }), error => ({ error })).then(result => { outcome = result; return result; });
  await entered.promise;
  try {
    await sleep(1200);
    t.diagnostic(`After 1.2s with a 1s request timeout: requestSettled=${!!outcome}; healthAborted=${observedSignal.aborted}; active=${gateway.snapshot().groups[0].active}`);
    assert.ok(outcome?.error, "The 1-second deadline must end this request rather than wait for the independent preparation timeout.");
    assert.equal(gateway.snapshot().groups[0].active, 0, "Mock cleanup acknowledges immediately, so the expired reservation must be released.");
  } finally {
    release.resolve();
    await request;
  }
});
