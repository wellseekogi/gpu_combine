import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {initialState, transition, hash, fixture, available, assertInvariants, LEASE_MS} from "../lib/relay/engine.mjs";
import {execute} from "../lib/relay/service.mjs";
import {createMaintenanceScheduler} from "../standalone/maintenance.mjs";

const start = 1700000000000;
const model = {name: "test model", digest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 8192, minVram: 0};
const contract = {modelDigest: model.digest, runtime: model.runtime, template: model.template};
const document = {title: "Public fixture", text: "License: MIT", url: "https://example.org/spec"};
const request = extra => ({title: "Maintenance test", fields: ["License"], documents: [document], publicData: true, budget: 40, minutes: 30, modelId: "fixture-v1", ...extra});

class SqliteStore {
  constructor(entries = [], filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("CREATE TABLE relay_pools(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL)");
    this.conflicts = 0;
    this.beforeSwap = null;
    for (const [id, state] of entries) this.db.prepare("INSERT INTO relay_pools VALUES (?,0,?)").run(id, typeof state === "string" ? state : JSON.stringify(state));
  }
  read = async id => { await Promise.resolve(); return this.db.prepare("SELECT revision,state FROM relay_pools WHERE id=?").get(id); };
  insert = async (id, state) => this.db.prepare("INSERT OR IGNORE INTO relay_pools VALUES (?,0,?)").run(id, state);
  compareAndSwap = async (id, revision, state) => {
    if (this.beforeSwap) await this.beforeSwap();
    const changed = this.db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").run(state, id, revision).changes === 1;
    if (!changed) this.conflicts++;
    return changed;
  };
  listPoolIds = async (after, limit) => this.db.prepare("SELECT id FROM relay_pools WHERE id>? ORDER BY id LIMIT ?").all(after ?? "", limit).map(row => row.id);
  state(id = "local-owner") { return JSON.parse(this.db.prepare("SELECT state FROM relay_pools WHERE id=?").get(id).state); }
  revision(id = "local-owner") { return this.db.prepare("SELECT revision FROM relay_pools WHERE id=?").get(id).revision; }
  close() { this.db.close(); }
}

async function live({leased = true, minutes = 30} = {}) {
  const state = initialState(start);
  const approved = await transition(state, "live", "model", model, start);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const node = await transition(state, "live", "node", {name: "Test provider", modelId: approved.modelId, vram: 0, tokenHash: await hash(token)}, start);
  await transition(state, "live", "create", request({modelId: approved.modelId, minutes}), start);
  const task = leased ? (await transition(state, "live", "poll", contract, start, node.nodeId)).task : null;
  const payload = task && {...contract, taskId: task.taskId, attemptId: task.lease.attemptId, epoch: task.lease.epoch, raw: fixture(document, ["License"]), finishReason: "stop"};
  return {state, approved, node, token, task, payload};
}

function scheduler(store, options = {}) {
  return createMaintenanceScheduler({store, listPoolIds: store.listPoolIds, intervalMs: 5, ...options});
}
async function waitUntil(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw Error("Timed out waiting for background maintenance.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function timeout(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Timed out waiting for child process.")), ms); })]); }
  finally { clearTimeout(timer); }
}

// The tests below start the actual timer and never submit a UI tick.
test("background timer expires a live lease and keeps the retry reservation", async t => {
  const {state} = await live();
  const store = new SqliteStore([["local-owner", state]]);
  const maintenance = scheduler(store, {clock: () => start + LEASE_MS + 1});
  t.after(async () => { await maintenance.stop(); store.close(); });
  maintenance.start();
  await waitUntil(() => store.state().books.live.jobs[0].tasks[0].status === "ready");
  await maintenance.stop();
  const current = store.state(), job = current.books.live.jobs[0];
  assert.equal(job.tasks[0].lease, undefined);
  assert.equal(job.tasks[0].attempts.length, 1);
  assert.equal(job.tasks[0].attempts[0].status, "expired");
  assert.equal(job.reserved, 10);
  assert.equal(current.books.live.accounts.requester, 1000);
  assertInvariants(current);
});

test("background timer releases an unassigned job reservation at its deadline", async t => {
  const {state} = await live({leased: false, minutes: 1});
  const store = new SqliteStore([["local-owner", state]]);
  const maintenance = scheduler(store, {clock: () => start + 60001});
  t.after(async () => { await maintenance.stop(); store.close(); });
  maintenance.start();
  await waitUntil(() => store.state().books.live.jobs[0].status === "partial");
  await maintenance.stop();
  const current = store.state(), book = current.books.live;
  assert.equal(book.jobs[0].tasks[0].status, "failed");
  assert.equal(book.jobs[0].reserved, 0);
  assert.equal(available(book), 1000);
  assert.equal(book.ledger.filter(entry => entry.type === "settlement").length, 0);
  assertInvariants(current);
});

test("background expiry releases reservation after the attempt cap", async t => {
  const {state} = await live();
  state.books.live.jobs[0].retryLimit = 1;
  const store = new SqliteStore([["local-owner", state]]);
  const maintenance = scheduler(store, {clock: () => start + LEASE_MS + 1});
  t.after(async () => { await maintenance.stop(); store.close(); });
  await maintenance.runOnce();
  const current = store.state();
  assert.equal(current.books.live.jobs[0].tasks[0].status, "failed");
  assert.equal(available(current.books.live), 1000);
  assertInvariants(current);
});

test("demo dispatch and settlement progress with the browser closed", async t => {
  const state = initialState(start);
  await transition(state, "demo", "create", request(), start);
  const store = new SqliteStore([["local-owner", state]]);
  let now = start;
  const maintenance = scheduler(store, {clock: () => now});
  t.after(async () => { await maintenance.stop(); store.close(); });
  maintenance.start();
  await waitUntil(() => store.state().books.demo.jobs[0].status === "running");
  now += 7001;
  await waitUntil(() => store.state().books.demo.jobs[0].status === "completed");
  await maintenance.stop();
  const current = store.state();
  assert.equal(current.books.demo.accounts.requester, 990);
  assert.equal(current.books.demo.ledger.filter(entry => entry.type === "settlement").length, 1);
  assert.equal(current.books.live.accounts.requester, 1000);
  assertInvariants(current);
});

test("maintenance and concurrent duplicate provider results settle once through CAS", async t => {
  const setup = await live();
  await transition(setup.state, "live", "create", request({modelId: setup.approved.modelId, minutes: 1}), start);
  for (const elapsed of [25000, 50000]) await transition(setup.state, "live", "poll", {...contract, attemptId: setup.payload.attemptId, epoch: setup.payload.epoch}, start + elapsed, setup.node.nodeId);
  const store = new SqliteStore([["local-owner", setup.state]]);
  const maintenance = scheduler(store, {clock: () => start + 60001});
  t.after(async () => { await maintenance.stop(); store.close(); });
  let releaseFirst, reachedFirst, held = false;
  const reached = new Promise(resolve => { reachedFirst = resolve; });
  store.beforeSwap = async () => {
    if (held) return;
    held = true;
    reachedFirst();
    await new Promise(resolve => { releaseFirst = resolve; });
  };
  const command = {mode: "live", action: "submit", nodeId: setup.node.nodeId, token: setup.token, payload: setup.payload};
  const first = execute(store, "local-owner", {...command}, {provider: true, now: start + 60001});
  await reached;
  const [, second] = await Promise.all([maintenance.runOnce(), execute(store, "local-owner", {...command}, {provider: true, now: start + 60001})]);
  releaseFirst();
  const completed = await first;
  assert.equal(completed.result.receipt, second.result.receipt);
  assert.ok(store.conflicts > 0);
  const current = store.state(), book = current.books.live;

  assert.equal(book.jobs.filter(job => job.status === "partial").length, 1);
  assert.equal(book.jobs.filter(job => job.status === "completed").length, 1);
  assert.equal(book.accounts.requester, 990);
  assert.equal(book.accounts.operator, 1);
  assert.equal(book.ledger.filter(entry => entry.type === "settlement").length, 1);
  assertInvariants(current);
});

test("idle and missing pools are not rewritten or created", async t => {
  const store = new SqliteStore([["local-owner", initialState(start)]]);
  const maintenance = scheduler(store, {clock: () => start + 999999});
  t.after(async () => { await maintenance.stop(); store.close(); });
  const result = await maintenance.runOnce();
  assert.deepEqual(result, {pools: 1, ticks: 0, errors: 0});
  assert.equal(store.revision(), 0);
  store.db.prepare("DELETE FROM relay_pools").run();
  assert.deepEqual(await maintenance.runOnce(), {pools: 0, ticks: 0, errors: 0});
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM relay_pools").get().count, 0);
});

test("maintenance pages existing pools within its per-pass bound", async t => {
  const {state} = await live({leased: false, minutes: 1});
  const store = new SqliteStore(["a", "b", "c"].map(id => [id, state]));
  const maintenance = scheduler(store, {maxPoolsPerRun: 2, clock: () => start + 60001});
  t.after(async () => { await maintenance.stop(); store.close(); });
  assert.equal((await maintenance.runOnce()).pools, 2);
  assert.deepEqual(["a", "b", "c"].map(id => store.revision(id)), [1, 1, 0]);
  assert.equal((await maintenance.runOnce()).pools, 1);
  assert.deepEqual(["a", "b", "c"].map(id => store.revision(id)), [1, 1, 1]);
});

test("one corrupt pool does not prevent recovery of another pool", async t => {
  const {state} = await live({leased: false, minutes: 1});
  const store = new SqliteStore([["a", "invalid JSON"], ["b", state]]);
  const errors = [];
  const maintenance = scheduler(store, {clock: () => start + 60001, onError: (error, context) => errors.push({error, ...context})});
  t.after(async () => { await maintenance.stop(); store.close(); });
  const result = await maintenance.runOnce();
  assert.equal(result.errors, 1);
  assert.equal(errors[0].poolId, "a");
  assert.equal(store.state("b").books.live.jobs[0].status, "partial");
});

test("overlapping passes coalesce and shutdown drains the active pass", async () => {
  let release, reached, calls = 0;
  const started = new Promise(resolve => { reached = resolve; });
  const maintenance = createMaintenanceScheduler({
    store: {read: async () => { throw Error("No read may begin after shutdown."); }},
    listPoolIds: async () => { calls++; reached(); await new Promise(resolve => { release = resolve; }); return ["pool"]; },
  });
  const first = maintenance.runOnce();
  const second = maintenance.runOnce();
  assert.strictEqual(first, second);
  await started;
  let stopped = false;
  const stop = maintenance.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([first, stop]);
  assert.equal(calls, 1);
  assert.equal(stopped, true);
  assert.deepEqual(await maintenance.runOnce(), {pools: 0, ticks: 0, errors: 0});
});

test("a transient pool-list failure is retried on the next timer pass", async t => {
  const {state} = await live({leased: false, minutes: 1});
  const store = new SqliteStore([["local-owner", state]]);
  let calls = 0;
  const errors = [];
  const maintenance = scheduler(store, {
    clock: () => start + 60001,
    listPoolIds: async (...args) => { if (calls++ === 0) throw Error("temporary database outage"); return store.listPoolIds(...args); },
    onError: error => errors.push(error),
  });
  t.after(async () => { await maintenance.stop(); store.close(); });
  maintenance.start();
  await waitUntil(() => store.state().books.live.jobs[0].status === "partial");
  await maintenance.stop();
  assert.equal(errors.length, 1);
  assert.ok(calls >= 2);
});

test("standalone boot recovers persisted deadlines without any HTTP request and shuts down over IPC", async t => {
  const work = resolve("work");
  await mkdir(work, {recursive: true});
  const directory = await mkdtemp(join(work, "maintenance-server-"));
  const filename = join(directory, "relay.sqlite");
  const {state} = await live({minutes: 1});
  const seed = new SqliteStore([["local-owner", state]], filename);
  seed.close();
  let child, observer, logs = "";
  t.after(async () => {
    if (observer) observer.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      if (child.connected) child.send("relay:shutdown"); else child.kill();
      try { await timeout(ended); } catch { child.kill(); await timeout(ended); }
    }
    assert.equal(dirname(resolve(directory)), work);
    await rm(directory, {recursive: true, force: true});
  });
  child = spawn(process.execPath, ["standalone/server.mjs"], {
    env: {...process.env, RELAY_ADMIN_TOKEN: "f".repeat(64), RELAY_DATA_DIR: directory, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_MAINTENANCE_MS: "250"},
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  const [message] = await timeout(once(child, "message"));
  assert.equal(message, "relay:ready");
  observer = new DatabaseSync(filename);
  const restored = () => JSON.parse(observer.prepare("SELECT state FROM relay_pools WHERE id='local-owner'").get().state);
  await waitUntil(() => restored().books.live.jobs[0].status === "partial");
  const current = restored();
  assert.equal(current.books.live.jobs[0].reserved, 0);
  assert.equal(current.books.live.accounts.requester, 1000);
  assert.equal(current.books.live.ledger.filter(entry => entry.type === "settlement").length, 0);
  assertInvariants(current);
  observer.close(); observer = null;
  const ended = once(child, "exit");
  child.send("relay:shutdown");
  const [code, signal] = await timeout(ended);
  assert.equal(code, 0, logs);
  assert.equal(signal, null, logs);
  assert.doesNotMatch(logs, /maintenance failed|shutdown failed/);
});
