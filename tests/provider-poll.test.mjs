import test from "node:test";
import assert from "node:assert/strict";
import {createProviderPollHub} from "../standalone/provider-poll.mjs";
import {execute} from "../lib/relay/service.mjs";
import {initialState, transition, hash} from "../lib/relay/engine.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const status = expected => error => error.status === expected;

test("provider wakeups cannot miss a committed change before waiter registration", async t => {
  const hub = createProviderPollHub(); t.after(() => hub.close());
  const observed = hub.version("pool");
  hub.notify("pool");
  await hub.wait("pool", "node", observed, 10000);
  const waiting = hub.wait("pool", "node", hub.version("pool"), 10000);
  hub.notify("pool"); await waiting;
  const again = hub.wait("pool", "node", hub.version("pool"), 10000);
  hub.notify("pool"); await again;
});

test("idle waiters stay isolated, bounded, and release capacity after abort or shutdown", async t => {
  const hub = createProviderPollHub(); t.after(() => hub.close());
  const client = new AbortController(); let otherWoke = false;
  const first = hub.wait("first", "node", 0, 10000);
  const second = hub.wait("second", "node", 0, 10000, client.signal).then(() => { otherWoke = true; });
  await assert.rejects(hub.wait("first", "node", 0, 10000), status(409));
  hub.notify("first"); await first; await tick();
  assert.equal(otherWoke, false);
  const canceled = assert.rejects(second, error => error.name === "AbortError");
  client.abort(); await canceled;
  const all = Array.from({length: 20}, (_, index) => hub.wait("first", String(index), hub.version("first"), 10000));
  await assert.rejects(hub.wait("first", "overflow", hub.version("first"), 10000), status(429));
  const closed = all.map(promise => assert.rejects(promise, status(503)));
  hub.close(); await Promise.all(closed);
  await assert.rejects(hub.wait("first", "after-close", 0, 10000), status(503));
});

test("idle wait timeout removes its waiter and permits another request", async t => {
  const hub = createProviderPollHub(); t.after(() => hub.close());
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await hub.wait("pool", "node", 0, 5);
  const again = hub.wait("pool", "node", 0, 10000);
  hub.notify("pool"); await again;
});

async function fixture(nodeCount = 1) {
  const now = 1700000000000, state = initialState(now);
  const model = {name: "Poll test", digest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 8192, minVram: 0};
  const approved = await transition(state, "live", "model", model, now), token = crypto.randomUUID() + crypto.randomUUID();
  const node = await transition(state, "live", "node", {name: "Waiter", modelId: approved.modelId, vram: 0, tokenHash: await hash(token)}, now);
  const nodes = [node];
  for (let i = 1; i < nodeCount; i++) nodes.push(await transition(state, "live", "node", {name: "Waiter " + i, modelId: approved.modelId, vram: 0, tokenHash: await hash(token)}, now));
  let row = {revision: 0, state: JSON.stringify(state)}, conflicts = 0;
  const notices = [];
  const store = {
    read: async () => row,
    compareAndSwap: async (_poolId, revision, serialized) => {
      if (conflicts) { conflicts--; assert.equal(notices.length, 0, "A failed CAS cannot publish a notification."); return false; }
      assert.equal(revision, row.revision); row = {revision: revision + 1, state: serialized}; return true;
    },
    notify: poolId => notices.push({poolId, revision: row.revision, state: JSON.parse(row.state)}),
  };
  const command = {mode: "live", action: "poll", nodeId: node.nodeId, token,
    payload: {modelDigest: model.digest, runtime: model.runtime, template: model.template}};
  return {store, command, nodes, notices, now, modelId: approved.modelId, conflict: count => { conflicts = count; }};
}

test("only durable live changes wake providers; idle heartbeat and demo mutations stay quiet", async () => {
  const f = await fixture();
  await execute(f.store, "pool", f.command, {provider: true, now: f.now});
  assert.equal(f.notices.length, 0);
  await execute(f.store, "pool", {mode: "demo", action: "tick", requestId: crypto.randomUUID()}, {now: f.now});
  assert.equal(f.notices.length, 0);
  f.conflict(2);
  const created = await execute(f.store, "pool", {mode: "live", action: "create", requestId: crypto.randomUUID(), payload: {
    title: "Wake immediately", modelId: f.modelId, publicData: true, fields: ["License"],
    documents: [{title: "Public", text: "License MIT", url: ""}], budget: 20, minutes: 30,
  }}, {now: f.now});
  assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].state.books.live.jobs.some(job => job.id === created.result.jobId));
  const claimed = await execute(f.store, "pool", f.command, {provider: true, now: f.now});
  assert.ok(claimed.result.task);
  assert.equal(f.notices.length, 2, "A committed dispatch is visible to waiting peers.");
  const renew = {...f.command, payload: {...f.command.payload, attemptId: claimed.result.task.lease.attemptId, epoch: claimed.result.task.lease.epoch}};
  await execute(f.store, "pool", renew, {provider: true, now: f.now + 1000});
  assert.equal(f.notices.length, 2, "Renewals must not trigger a polling storm.");
  await execute(f.store, "pool", {...f.command, action: "status", payload: {}}, {provider: true, now: f.now + 31001});
  assert.equal(f.notices.length, 3, "Even a status request that sweeps an expired lease wakes idle peers.");
});

test("exhausting the CAS retry limit never emits a provider notification", async () => {
  const f = await fixture(); f.conflict(10);
  await assert.rejects(execute(f.store, "pool", {mode: "live", action: "tick", requestId: crypto.randomUUID()}, {now: f.now}), status(409));
  assert.equal(f.notices.length, 0);
});

test("a provider canceled while queued cannot authenticate or mutate state after its turn starts", async () => {
  const f = await fixture(), client = new AbortController();
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  f.store.runCommand = async operation => { await ready; return operation(); };
  f.store.read = () => assert.fail("Canceled queued command must not reach the store.");
  const queued = execute(f.store, "pool", f.command, {provider: true, now: f.now, signal: client.signal});
  const aborted = assert.rejects(queued, error => error.name === "AbortError");
  client.abort(); release(); await aborted;
  assert.equal(f.notices.length, 0);
});
