import test from "node:test";
import assert from "node:assert/strict";
import {fixture as extraction} from "../lib/relay/engine.mjs";
import {bootAuditServer} from "./audit-server-helper.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test("opt-in provider wait wakes on durable work and preserves auth, lease, cancel and shutdown boundaries", async t => {
  const server = await bootAuditServer(); t.after(() => server.close());
  const login = await fetch(server.origin + "/api/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token: server.admin})});
  const cookie = login.headers.get("set-cookie").split(";")[0]; await login.body.cancel();
  async function send(path, body, {key, signal} = {}) {
    const response = await fetch(server.origin + path, {method: "POST", signal,
      headers: {"Content-Type": "application/json", Cookie: cookie, ...(key && {Authorization: "Bearer " + key})}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  }
  const admin = (action, payload) => send("/api/relay", {mode: "live", action, payload, requestId: crypto.randomUUID()});
  const model = {name: "Long poll fixture", digest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 8192, minVram: 0};
  const approved = (await admin("model", model)).body.result;
  const key = crypto.randomUUID() + crypto.randomUUID();
  const node = (await admin("node", {name: "Waiting GPU", modelId: approved.modelId, vram: 0, token: key})).body.result;
  const nodes = [{nodeId: node.nodeId, key}];
  const contract = {modelDigest: model.digest, runtime: model.runtime, template: model.template};
  const poll = (waitMs, extra = {}, options = {}) => send("/api/provider", {poolId: "local-owner", nodeId: node.nodeId, action: "poll", payload: contract,
    ...(waitMs === undefined ? {} : {waitMs}), ...extra}, {key, ...options});

  await t.test("strict opt-in is limited to authenticated idle requests, while legacy replies stay unchanged", async () => {
    for (const waitMs of [-1, 10001, true, null, 1.5, "10"]) assert.equal((await poll(waitMs)).status, 400);
    assert.equal((await poll(10, {action: "status"})).status, 400);
    for (const payload of [{...contract, attemptId: "old"}, {...contract, epoch: 1}, {...contract, rentalId: "rental"}])
      assert.equal((await poll(10, {payload})).status, 400);
    assert.equal((await poll(10000, {}, {key: "invalid", signal: AbortSignal.timeout(2000)})).status, 401);
    const legacy = await poll();
    assert.equal(legacy.status, 200); assert.equal(legacy.body.result.task, null);
    assert.equal(Object.hasOwn(legacy.body.result, "waitSupported"), false);
    const started = performance.now(), waiting = await poll(50);
    assert.equal(waiting.body.result.waitSupported, true);
    assert.equal(waiting.body.result.task, null);
    assert.ok(performance.now() - started >= 40);
  });

  await t.test("new work wakes a pending request immediately and the returned task retains its lease fence", async () => {
    const waiting = poll(5000); await sleep(50);
    const document = {title: "Public", text: "License MIT", url: ""}, started = performance.now();
    assert.equal((await admin("create", {title: "Wake waiting provider", modelId: approved.modelId, publicData: true,
      fields: ["License"], documents: [document], budget: 20, minutes: 30})).status, 200);
    const claimed = await waiting;
    assert.equal(claimed.status, 200); assert.equal(claimed.body.result.waitSupported, true);
    const task = claimed.body.result.task;
    assert.ok(task?.lease.attemptId);
    t.diagnostic(`Job-create request start to provider response: ${(performance.now() - started).toFixed(1)} ms on synthetic loopback HTTP.`);
    assert.ok(performance.now() - started < 2000, "A new job should wake the request before its 5-second timeout.");
    const renew = await poll(undefined, {payload: {...contract, attemptId: task.lease.attemptId, epoch: task.lease.epoch}});
    assert.equal(renew.status, 200); assert.equal(renew.body.result.task, null);
    assert.equal(Object.hasOwn(renew.body.result, "waitSupported"), false);
    const settled = await send("/api/provider", {poolId: "local-owner", nodeId: node.nodeId, action: "submit", payload: {
      ...contract, taskId: task.taskId, attemptId: task.lease.attemptId, epoch: task.lease.epoch,
      raw: extraction(document, ["License"]), finishReason: "stop",
    }}, {key});
    assert.equal(settled.status, 200);
  });

  await t.test("a broadcast to twenty authenticated idle providers avoids admission failures", async () => {
    for (let index = 1; index < 20; index++) {
      const nextKey = crypto.randomUUID() + crypto.randomUUID();
      const registered = await admin("node", {name: "Burst waiter " + index, modelId: approved.modelId, vram: 0, token: nextKey});
      assert.equal(registered.status, 200);
      nodes.push({nodeId: registered.body.result.nodeId, key: nextKey});
    }
    const waiting = nodes.map(entry => poll(1000, {nodeId: entry.nodeId}, {key: entry.key}));
    await sleep(50);
    const started = performance.now();
    const created = await admin("create", {title: "Wake provider burst", modelId: approved.modelId, publicData: true,
      fields: ["License"], documents: Array.from({length: 4}, (_, index) => ({title: "Public " + index, text: "License MIT", url: ""})), budget: 40, minutes: 30});
    assert.equal(created.status, 200);
    const responses = await Promise.all(waiting);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(responses.filter(response => response.body.result?.task).length, 4);
    t.diagnostic(`Twenty live waiters: ${responses.filter(response => response.status === 200).length} successful replies, four fenced claims, batch ${(performance.now() - started).toFixed(1)} ms including 1-second idle deadlines.`);
    assert.equal((await admin("cancel", {jobId: created.body.result.jobId})).status, 200);
  });

  await t.test("pause/revoke wake a waiter, duplicate waiters are rejected, and disconnect frees its slot", async () => {
    const paused = poll(5000); await sleep(40);
    assert.equal((await admin("pause", {nodeId: node.nodeId})).status, 200);
    assert.equal((await paused).body.result.paused, true);
    await admin("resume", {nodeId: node.nodeId});
    const client = new AbortController(), waiting = poll(5000, {}, {signal: client.signal});
    const canceled = assert.rejects(waiting, error => error.name === "AbortError");
    await sleep(40);
    assert.equal((await poll(10)).status, 409);
    client.abort(); await canceled; await sleep(40);
    assert.equal((await poll(10)).status, 200);
    const revoked = poll(5000); await sleep(40);
    await admin("revoke", {nodeId: node.nodeId});
    assert.equal((await revoked).status, 401);
  });

  await t.test("shutdown releases pending requests before the forced socket deadline", async () => {
    const next = nodes[1];
    const waiting = poll(10000, {nodeId: next.nodeId}, {key: next.key}); await sleep(40);
    const started = performance.now(), stopped = server.close();
    assert.equal((await waiting).status, 503);
    assert.ok(performance.now() - started < 2000);
    await stopped;
  });
});
