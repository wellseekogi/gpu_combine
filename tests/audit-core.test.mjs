// Independent audit regressions: these express the required safe behavior.
// Run explicitly with: node --test tests/audit-core.test.mjs
// No actual Relay database, keys, external service, or GPU is accessed.
import test from "node:test";
import assert from "node:assert/strict";
import {initialState, transition, hash, fixture, assertInvariants, LEASE_MS, RelayError} from "../lib/relay/engine.mjs";
import {execute} from "../lib/relay/service.mjs";
import {createMaintenanceScheduler} from "../standalone/maintenance.mjs";

const START = 1700000000000;
const DOC = {title: "Audit document", text: "license: MIT", url: "https://example.org/"};
const MODEL = {name: "Audit model", digest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 8192, minVram: 4096};
const CONTRACT = {modelDigest: MODEL.digest, runtime: MODEL.runtime, template: MODEL.template};
const request = (extra = {}) => ({title: "Audit", fields: ["license"], documents: [DOC], budget: 100, minutes: 30, publicData: true, modelId: "fixture-v1", ...extra});
const admin = (action, payload = {}, mode = "demo") => ({mode, action, payload, requestId: crypto.randomUUID()});

class MemoryStore {
  constructor(state = initialState(START)) { this.row = {revision: 0, state: JSON.stringify(state)}; }
  async read() { return {...this.row}; }
  async insert(_id, state) { this.row ??= {revision: 0, state}; }
  async compareAndSwap(_id, revision, state) {
    if (this.row.revision !== revision) return false;
    this.row = {revision: revision + 1, state};
    return true;
  }
  state() { return JSON.parse(this.row.state); }
}

async function live() {
  const state = initialState(START);
  const {modelId} = await transition(state, "live", "model", MODEL, START);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const {nodeId} = await transition(state, "live", "node", {name: "Audit GPU", modelId, vram: 8192, tokenHash: await hash(token)}, START);
  await transition(state, "live", "create", request({modelId}), START);
  const {task} = await transition(state, "live", "poll", CONTRACT, START, nodeId);
  return {store: new MemoryStore(state), nodeId, token, task};
}

test("audit: malformed document must produce a typed client error without committing state", async () => {
  const store = new MemoryStore();
  const before = store.row.state;
  await assert.rejects(execute(store, "audit", admin("create", request({documents: [null]})), {now: START}),
    error => error instanceof RelayError && error.status === 400,
    "documents:[null] must be rejected as invalid input, not an unhandled TypeError / HTTP 503");
  assert.equal(store.row.state, before);
});

test("audit: malformed explicit node allowlist must never become unrestricted placement", async () => {
  const store = new MemoryStore();
  const before = store.row.state;
  await assert.rejects(execute(store, "audit", admin("create", request({allowedNodes: "demo-2"})), {now: START}),
    error => error instanceof RelayError && error.status === 400,
    "an explicit non-array allowlist must be rejected instead of silently converted to []");
  assert.equal(store.row.state, before);
});

test("audit: malformed stale heartbeat must not grant another attempt", async () => {
  const {store, nodeId, token, task} = await live();
  const before = store.row.state;
  const command = {mode: "live", nodeId, token, action: "poll", payload: {...CONTRACT, attemptId: "", epoch: task.lease.epoch}};
  await assert.rejects(execute(store, "audit", command, {provider: true, now: START + LEASE_MS + 1}),
    error => error instanceof RelayError && [400, 409].includes(error.status),
    "a supplied renewal epoch with an empty attempt ID must not be interpreted as a fresh claim");
  assert.equal(store.row.state, before);
});

test("audit: accepted long Korean demo input must not roll back unrelated job completion", async () => {
  const state = initialState(START);
  await transition(state, "demo", "create", request({title: "long", documents: [{...DOC, text: "license: " + "가".repeat(3991)}]}), START);
  await transition(state, "demo", "create", request({title: "healthy"}), START + 1);
  await transition(state, "demo", "tick", {}, START + 2);
  const store = new MemoryStore(state);
  const errors = [];
  let now = START;
  const scheduler = createMaintenanceScheduler({store, listPoolIds: async () => ["audit"], clock: () => now, onError: error => errors.push(error)});
  try {
    for (const elapsed of [7003, 30003, 37004, 60004, 67005, 90005]) {
      now = START + elapsed;
      await scheduler.runOnce();
    }
    const result = {errors: errors.length};
    const healthy = store.state().books.demo.jobs.find(job => job.title === "healthy");
    assert.equal(healthy.status, "completed", `valid unrelated job became ${healthy.status}/${healthy.tasks[0].status} after ${healthy.tasks[0].attempts.length} attempts; maintenance errors=${result.errors}: ${errors.map(error => error.message).join(", ")}`);
    assert.equal(healthy.tasks[0].attempts.length, 1);
    const long = store.state().books.demo.jobs.find(job => job.title === "long");
    assert.equal(long.status, "partial");
    assert.equal(long.tasks[0].status, "settled");
    assert.equal(long.tasks[0].attempts.length, 1);
    assert.equal(long.tasks[0].items[0].value, null);
    assert.equal(errors.length, 0);
    assert.equal(store.state().books.demo.ledger.filter(entry => entry.type === "settlement").length, 2);
    assertInvariants(store.state());
  } finally { await scheduler.stop(); }
});

test("audit control: invalid usage never commits partial settlement", async () => {
  const {store, nodeId, token, task} = await live();
  const before = store.row.state;
  await assert.rejects(execute(store, "audit", {mode: "live", action: "submit", nodeId, token, payload: {...CONTRACT, taskId: task.taskId, attemptId: task.lease.attemptId, epoch: task.lease.epoch, raw: fixture(DOC, ["license"]), finishReason: "stop", usage: {total_tokens: -1}}}, {provider: true, now: START + 1}), error => error instanceof RelayError && error.status === 400);
  assert.equal(store.row.state, before);
  assertInvariants(store.state());
});

test("audit control: renewal hard stop and exact expiry reject old results", async () => {
  const {store, nodeId, token, task} = await live();
  const poll = {mode: "live", nodeId, token, action: "poll", payload: {...CONTRACT, attemptId: task.lease.attemptId, epoch: task.lease.epoch}};
  for (let elapsed = 20000; elapsed <= 160000; elapsed += 20000) {
    const result = await execute(store, "audit", poll, {provider: true, now: START + elapsed});
    assert.ok(result.result.lease.expiresAt <= START + 180000);
  }
  await assert.rejects(execute(store, "audit", poll, {provider: true, now: START + 180000}), error => error instanceof RelayError && error.status === 409);
  await assert.rejects(execute(store, "audit", {mode: "live", nodeId, token, action: "submit", payload: {...CONTRACT, taskId: task.taskId, attemptId: task.lease.attemptId, epoch: task.lease.epoch, raw: fixture(DOC, ["license"]), finishReason: "stop"}}, {provider: true, now: START + 180000}), error => error instanceof RelayError && error.status === 409);
  assert.equal(store.state().books.live.accounts.requester, 1000);
  assertInvariants(store.state());
});



test("audit: all malformed document and allowlist types are rejected without committing", async () => {
  const store = new MemoryStore();
  const before = {...store.row};
  for (const document of [null, [], true, 7, "text"]) {
    await assert.rejects(execute(store, "audit", admin("create", request({documents: [document]})), {now: START}),
      error => error instanceof RelayError && error.status === 400);
    assert.deepEqual(store.row, before);
  }
  for (const allowedNodes of [null, false, 0, {}, "demo-2", [null], ["missing-node"]]) {
    await assert.rejects(execute(store, "audit", admin("create", request({allowedNodes})), {now: START}),
      error => error instanceof RelayError && error.status === 400);
    assert.deepEqual(store.row, before);
  }
});

test("audit: omitted or empty allowlist still permits normal placement", async () => {
  for (const extra of [{}, {allowedNodes: []}, {allowedNodes: ["demo-2"]}]) {
    const state = initialState(START);
    await transition(state, "demo", "create", request(extra), START);
    await transition(state, "demo", "tick", {}, START + 1);
    assert.equal(state.books.demo.jobs[0].tasks[0].lease.nodeId, extra.allowedNodes?.length ? "demo-2" : "demo-0");
    assertInvariants(state);
  }
});

test("audit: supplied heartbeat fields never fall through to a fresh claim", async () => {
  const {store, nodeId, token, task} = await live();
  const before = {...store.row};
  const attemptId = task.lease.attemptId;
  const malformed = [
    {epoch: 1}, {attemptId}, {attemptId: null, epoch: 1}, {attemptId: false, epoch: 1},
    {attemptId: "", epoch: 1}, {attemptId: " ", epoch: 1}, {attemptId: "a".repeat(81), epoch: 1},
    {attemptId, epoch: null}, {attemptId, epoch: 0}, {attemptId, epoch: -1},
    {attemptId, epoch: 1.5}, {attemptId, epoch: "1"},
  ];
  for (const now of [START + 1, START + LEASE_MS + 1]) {
    for (const renewal of malformed) {
      await assert.rejects(execute(store, "audit", {mode: "live", action: "poll", nodeId, token, payload: {...CONTRACT, ...renewal}}, {provider: true, now}),
        error => error instanceof RelayError && error.status === 400);
      assert.deepEqual(store.row, before);
    }
  }
  const next = await execute(store, "audit", {mode: "live", action: "poll", nodeId, token, payload: CONTRACT}, {provider: true, now: START + LEASE_MS + 1});
  assert.equal(next.result.task.lease.epoch, 2);
  assert.notEqual(next.result.task.lease.attemptId, attemptId);
  assertInvariants(store.state());
});

test("audit: malformed payload is rejected before any storage access", async () => {
  const store = {read: async () => {throw new Error("invalid input must not access storage");}};
  for (const payload of [null, [], false, 123, "text"]) {
    await assert.rejects(execute(store, "audit", admin("tick", payload), {now: START}),
      error => error instanceof RelayError && error.status === 400);
  }
});

test("audit: demo fixture bounds multibyte and escaped output while preserving whole values", async () => {
  const fields = ["f0", "f1", "f2", "f3", "f4", "license"];
  for (const character of ["가", String.fromCharCode(0)]) {
    const text = fields.slice(0, -1).map(field => field + ": " + character.repeat(495)).concat("license: MIT").join("\n");
    const state = initialState(START);
    await transition(state, "demo", "create", request({fields, documents: [{...DOC, text}]}), START);
    await transition(state, "demo", "tick", {}, START + 1);
    await transition(state, "demo", "tick", {}, START + 7002);
    const job = state.books.demo.jobs[0];
    const task = job.tasks[0];
    assert.equal(task.status, "settled");
    assert.equal(task.quality, "partial");
    assert.equal(task.attempts.length, 1);
    assert.ok(Buffer.byteLength(task.raw) <= 12000);
    assert.ok(task.items.some(item => item.value === null));
    assert.ok(task.items.some(item => item.value === character.repeat(495)));
    for (const item of task.items.filter(item => item.value !== null)) {
      assert.equal(item.verified, true);
      assert.ok(item.quote.length <= 500);
      assert.equal(text.slice(item.start, item.end), item.quote);
    }
    assert.equal(task.items.find(item => item.field === "license").value, "MIT");
    assert.equal(job.spent, 10);
    assert.equal(job.reserved, 0);
    assertInvariants(state);
  }
});
