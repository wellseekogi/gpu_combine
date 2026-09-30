// Offline synthetic gateway benchmark; no GPU, network, credentials or live state.
// node --expose-gc scripts/benchmark-inference.mjs --samples 5 [--module path/to/inference.mjs]
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {parseArgs} from "node:util";
import {fileURLToPath, pathToFileURL} from "node:url";

const {values} = parseArgs({options: {module: {type: "string"}, samples: {type: "string", default: "5"}, extended: {type: "boolean", default: false}}});
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30, "samples must be 1..30");
assert.equal(typeof global.gc, "function", "Run Node with --expose-gc for comparable retained-memory measurements.");
const root = fileURLToPath(new URL("../", import.meta.url));
const modulePath = resolve(values.module ?? resolve(root, "lib/relay/inference.mjs"));
// Rebase only the gateway's local imports so an untouched saved baseline is runnable.
let source = await readFile(modulePath, "utf8");
for (const name of ["engine.mjs", "inference-plan.mjs"])
  source = source.replaceAll(`"./${name}"`, JSON.stringify(pathToFileURL(resolve(root, "lib/relay", name)).href));
source += `\n//# sourceURL=${pathToFileURL(modulePath).href}`;
const {createInferenceGateway} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const encoder = new TextEncoder(), tick = () => new Promise(resolve => setImmediate(resolve));
const template = "offline benchmark template";
const request = {model: "benchmark", messages: [{role: "user", content: "hello"}], max_tokens: 16};
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({choices: [{index: 0, delta, finish_reason}]})}\n\n`;
const ending = event({}, "stop") + 'data: {"choices":[],"usage":{"completion_tokens":16}}\n\ndata: [DONE]\n\n';
const headers = {"Content-Type": "text/event-stream"};

function fixture() {
  const backend = {chat: () => new Response(event({role: "assistant", content: "ok"}) + ending, {headers})};
  const gateway = createInferenceGateway({version: 1, requestTimeoutMs: 60000,
    groups: [{id: "group", model: "benchmark", backend: "llama.cpp", splitMode: "layer", topology: "lan",
      endpoint: "http://127.0.0.1:8081", modelSha256: "a".repeat(64),
      templateSha256: createHash("sha256").update(template).digest("hex"), slots: 1, contextTokens: 512,
      hourlyCost: 1, currency: "CR", modelArchitecture: {layers: 1, kvHeads: 1, headDim: 64, kvBytes: 2},
      gpus: [{id: "synthetic/GPU", layers: 1, vramMiB: 1024, weightsMiB: 100, workspaceMiB: 100, reserveMiB: 100}]}],
  }, {fetchImpl: async url => {
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({status: "ok"});
    if (path === "/props") return Response.json({total_slots: 1, default_generation_settings: {n_ctx: 512}, chat_template: template});
    if (path === "/v1/models") return Response.json({data: [{id: "benchmark"}]});
    if (path === "/slots") return Response.json([{id: 0, is_processing: false}]);
    if (path === "/slots/0") return Response.json({id_slot: 0, n_erased: 0});
    if (path.endsWith("/input_tokens")) return Response.json({input_tokens: 8});
    if (path === "/v1/chat/completions") return backend.chat();
    assert.fail(path);
  }});
  return {gateway, backend};
}

function chunked(bytes, chunkSize) {
  let offset = 0;
  return new Response(new ReadableStream({pull(output) {
    if (offset === bytes.length) output.close();
    else { const end = Math.min(bytes.length, offset + chunkSize); output.enqueue(bytes.subarray(offset, end)); offset = end; }
  }}, {highWaterMark: 0}), {headers});
}

async function drain(response) {
  const reader = response.body.getReader(); let size = 0;
  for (;;) { const {value, done} = await reader.read(); if (done) return size; size += value.byteLength; }
}

async function timed(name, payload, chunkSize, workspace = false, mode = "stream") {
  const {gateway, backend} = fixture(), bytes = encoder.encode(payload);
  const space = workspace && await gateway.createWorkspace(gateway.operator, {name: "benchmark", candidateId: "group"});
  backend.chat = () => chunked(bytes, chunkSize);
  const durations = [];
  try {
    for (let i = -1; i < samples; i++) {
      global.gc();
      const start = performance.now();
      const response = workspace ? await gateway.completeWorkspace(gateway.operator, space.id,
        {...request, ...(mode !== "stream" && {stream: true, restart_on_failure: mode === "restart"})}) :
        await gateway.complete(gateway.operator, {...request, stream: mode !== "json"});
      const size = await drain(response);
      if (!workspace || mode === "buffered") assert.equal(size, bytes.length);
      if (i >= 0) durations.push(performance.now() - start);
    }
  } finally { gateway.close(); }
  const sorted = [...durations].sort((a, b) => a - b), medianMs = sorted[Math.floor(sorted.length / 2)];
  return {name, bytes: bytes.length, chunkSize, samplesMs: durations.map(ms => +ms.toFixed(3)), medianMs: +medianMs.toFixed(3), MiBPerSecond: +(bytes.length / 1048576 / (medianMs / 1000)).toFixed(3)};
}

async function memory() {
  await tick(); global.gc(); global.gc();
  const {heapUsed, arrayBuffers} = process.memoryUsage();
  return {heapUsed, arrayBuffers};
}

async function retainedAnswer() {
  const {gateway, backend} = fixture();
  await drain(await gateway.complete(gateway.operator, {...request, stream: true}));
  const before = await memory();
  let pulls = 0;
  backend.chat = () => new Response(new ReadableStream({pull(output) {
    if (pulls === 128) return;
    output.enqueue(encoder.encode(event({role: "assistant", content: String(pulls++).padStart(8, "0") + "x".repeat(16384)})));
  }}, {highWaterMark: 0}), {headers});
  const response = await gateway.complete(gateway.operator, {...request, stream: true}), reader = response.body.getReader();
  for (let i = 0; i < 128; i++) assert.equal((await reader.read()).done, false);
  const after = await memory();
  await reader.cancel(); gateway.close();
  return {name: "consumed_2MiB_answer_still_generating", contentBytes: 128 * (16384 + 8), retainedHeapBytes: after.heapUsed - before.heapUsed,
    retainedArrayBufferBytes: after.arrayBuffers - before.arrayBuffers};
}

async function unreadWorkspace(chunkBytes = 32768, maxChunks = 80) {
  const {gateway, backend} = fixture(), space = await gateway.createWorkspace(gateway.operator, {name: "benchmark", candidateId: "group"});
  const before = await memory(); let pulls = 0, producedBytes = 0;
  backend.chat = () => new Response(new ReadableStream({pull(output) {
    if (pulls === maxChunks) { output.enqueue(encoder.encode(ending)); output.close(); return; }
    const chunk = encoder.encode(event({role: "assistant", content: String(pulls++).padStart(8, "0") + "x".repeat(chunkBytes)}));
    producedBytes += chunk.byteLength; output.enqueue(chunk);
  }}, {highWaterMark: 0}), {headers});
  const response = await gateway.completeWorkspace(gateway.operator, space.id, {...request, stream: true, restart_on_failure: true});
  const after = await memory();
  await response.body.cancel(); gateway.close();
  return {name: "unread_workspace_restart_stream" + (chunkBytes === 32768 ? "" : `_${chunkBytes}B_content_chunks`), producedChunks: pulls, producedBytes,
    retainedHeapBytes: after.heapUsed - before.heapUsed, retainedArrayBufferBytes: after.arrayBuffers - before.arrayBuffers};
}

const tokens = Array.from({length: 8192}, (_, index) => event({...(index === 0 && {role: "assistant"}), content: String(index).padStart(8, "0") + "x".repeat(120)})).join("") + ending;
const results = [
  await timed("fragmented_512KiB_event", event({role: "assistant", content: "x".repeat(512 * 1024)}) + ending, 512),
  await timed("8192_token_events", tokens, 16 * 1024),
  await timed("workspace_json_8192_token_events", tokens, 16 * 1024, true),
  ...(values.extended ? [
    await timed("8192_events_256B_chunks", tokens, 256),
    await timed("workspace_buffered_8192_events_256B_chunks", tokens, 256, true, "buffered"),
    await timed("workspace_restart_8192_events_256B_chunks", tokens, 256, true, "restart"),
    await timed("JSON_2MiB_16KiB_chunks", JSON.stringify({choices: [{message: {role: "assistant", content: "x".repeat(2 * 1048576)}, finish_reason: "stop"}]}), 16384, false, "json"),
  ] : []),
  await retainedAnswer(),
  await unreadWorkspace(),
  ...(values.extended ? [await unreadWorkspace(128, 8192)] : []),
];
console.log(JSON.stringify({node: process.version, platform: process.platform, module: modulePath, samples,
  scope: "Synthetic in-process CPU/heap only; excludes network transport, GPU kernels and model inference. Retained heap is GC-sensitive, not peak RSS.", results}, null, 2));
