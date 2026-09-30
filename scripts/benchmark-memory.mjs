// Synthetic, local-only measurements; no model, keys or existing database required.
// node --expose-gc scripts/benchmark-memory.mjs [baseline-source-directory]
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {spawnSync} from "node:child_process";
import {performance} from "node:perf_hooks";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import * as current from "../lib/relay/engine.mjs";

if (process.argv[2] === "--stream") {
  global.gc?.();
  const before = process.memoryUsage();
  let produced = 0;
  const total = 64 * 1024 ** 2, chunk = 65536;
  const source = new Readable({highWaterMark: chunk, read() {
    if (produced === total) return this.push(null);
    produced += chunk;
    this.push(Buffer.alloc(chunk, 1));
  }});
  const stream = Readable.toWeb(source);
  // No consumer: expose how far disk/network data can be read ahead.
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = process.memoryUsage();
  await stream.cancel();
  console.log(JSON.stringify({producedBytes: produced, arrayBufferDelta: after.arrayBuffers - before.arrayBuffers,
    rssDelta: after.rss - before.rss, totalBytes: total, chunkBytes: chunk}));
} else {
  const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
  function measure(operation, iterations = 100) {
    for (let index = 0; index < 10; index++) operation();
    const samples = [];
    for (let sample = 0; sample < 7; sample++) {
      global.gc?.();
      const start = performance.now();
      for (let index = 0; index < iterations; index++) operation();
      samples.push((performance.now() - start) / iterations);
    }
    return {medianMs: median(samples), samplesMs: samples, iterations};
  }
  const state = current.initialState(1700000000000), book = state.books.live;
  for (let index = 0; index < 1000; index++) {
    book.jobs.push({id: `job-${index}`, archived: true, spent: 10, reserved: 0, budget: 10,
      tasks: [{id: `task-${index}`, status: "settled"}], documents: []});
    book.ledger.push({type: "settlement", taskId: `task-${index}`, amount: 10});
  }
  for (let index = 0; index < 100; index++) book.accounts[`account-${index}`] = 0;
  state.receipts = Array.from({length: 512}, (_, index) => ({id: `receipt-${index}`, result: {text: "x".repeat(1000)}}));
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 1700000);

  async function rental(engine) {
    const now = 1700000000000, state = engine.initialState(now), payer = "member-" + crypto.randomUUID();
    const apply = (action, payload = {}, node) => engine.transition(state, "live", action, payload, now, node);
    await apply("member-account", {account: payer, initialCredit: 1000});
    const model = {name: "Synthetic", digest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 16384, minVram: 0};
    const {modelId} = await apply("model", model);
    const {nodeId} = await apply("node", {name: "Synthetic", modelId, vram: 0, tokenHash: "d".repeat(64)});
    const proof = {modelDigest: model.digest, runtime: model.runtime, template: model.template, capabilities: ["rental-session"]};
    await apply("poll", proof, nodeId);
    const artifact = {id: crypto.randomUUID(), name: "synthetic.gguf", digest: "e".repeat(64), size: 1024};
    const {jobId} = await engine.transition(state, "live", "rent", {payer, allowedNodes: [nodeId], context: 16384, publicData: true}, now, null, {modelArtifact: artifact});
    const ready = {...proof, rentalId: jobId, rentalStage: "ready"};
    await apply("poll", ready, nodeId);
    for (let turn = 0; turn < 30; turn++) {
      await apply("chat", {rentalId: jobId, prompt: `turn ${turn} ` + "p".repeat(256), maxTokens: 128});
      const {task} = await apply("poll", ready, nodeId);
      await apply("submit", {taskId: task.taskId, attemptId: task.lease.attemptId, epoch: task.lease.epoch,
        modelDigest: artifact.digest, runtime: model.runtime, template: model.template, raw: "a".repeat(256), finishReason: "stop",
        usage: {prompt_tokens: 50, completion_tokens: 64, total_tokens: 114}}, nodeId);
      engine.assertInvariants(state);
    }
    const job = state.books.live.jobs[0];
    assert.equal(job.messages.length, 60);
    assert.equal(job.spent, 30);
    return {turns: 30, serializedBytes: Buffer.byteLength(JSON.stringify(state)),
      storedTaskMessageCount: job.tasks.reduce((sum, task) => sum + task.messages.length, 0), historyMessageCount: job.messages.length};
  }
  const engines = {current};
  if (process.argv[2]) engines.baseline = await import(pathToFileURL(resolve(process.argv[2], "lib/relay/engine.mjs")));
  const report = {node: process.version, measuredAt: new Date().toISOString(), scope: "Native adapter bound (unchanged), synthetic valid <1.7 MB ledger and 30-turn rental; no GPU/WAN claims", engines: {}};
  {
    const child = spawnSync(process.execPath, ["--expose-gc", import.meta.filename, "--stream"], {encoding: "utf8", windowsHide: true});
    if (child.status !== 0) throw Error(child.stderr || "Stream benchmark failed");
    report.nativeStream = JSON.parse(child.stdout);
  }
  assert.ok(report.nativeStream.producedBytes <= 3 * 65536);
  for (const [name, engine] of Object.entries(engines)) {
    engine.assertInvariants(state);
    assert.deepEqual(engine.view(state, 1700000000000), current.view(state, 1700000000000));
    report.engines[name] = {invariants: measure(() => engine.assertInvariants(state)),
      snapshot: measure(() => engine.view(state, 1700000000000), 50), rental: await rental(engine)};
  }
  console.log(JSON.stringify(report, null, 2));
}
