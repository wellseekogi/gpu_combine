import test from "node:test";
import assert from "node:assert/strict";
import { planInferenceConfig, planTwoGpuLayers, planWorkspaceCandidates } from "../lib/relay/inference-plan.mjs";

function group(overrides = {}) {
  return {
    id: "group-1", model: "Qwen/Qwen3-32B", backend: "llama.cpp", splitMode: "layer",
    endpoint: "http://127.0.0.1:8081", modelSha256: "a".repeat(64), templateSha256: "b".repeat(64),
    contextTokens: 8192, slots: 1, topology: "lan",
    modelArchitecture: { layers: 64, kvHeads: 8, headDim: 128, kvBytes: 2 },
    gpus: [
      { id: "host-a/GPU-1", vramMiB: 16384, weightsMiB: 10000, workspaceMiB: 1024, reserveMiB: 1024, layers: 32 },
      { id: "host-b/GPU-2", vramMiB: 16384, weightsMiB: 10000, workspaceMiB: 1024, reserveMiB: 1024, layers: 32 },
    ],
    ...overrides,
  };
}

function plan(value = group()) {
  return planInferenceConfig({ version: 1, groups: [value] });
}

test("two-GPU planner searches legal boundaries, accounts for output weights and leaves the source untouched", () => {
  const value = group({contextTokens: 512, modelArchitecture: {layers: 4, kvHeads: 1, headDim: 1, kvBytes: 2}});
  value.gpus = value.gpus.map((gpu, i) => ({...gpu, vramMiB: i ? 16 : 10, workspaceMiB: 1, reserveMiB: 1}));
  value.performance = {source: "estimated"}; // A new placement cannot inherit old observations.
  const config = {version: 1, groups: [value]};
  const weights = {modelSha256: value.modelSha256, layerBytes: [3, 3, 3, 3].map(n => n * 1048576), firstStageExtraBytes: 0, lastStageExtraBytes: 2 * 1048576};
  const before = structuredClone(config);
  const result = planTwoGpuLayers(config, value.id, weights);
  assert.deepEqual(result.plan.gpus.map(gpu => gpu.layers), [1, 3]);
  assert.deepEqual(result.plan.gpus.map(gpu => gpu.weightsMiB), [3, 11]);
  assert.equal(result.feasibleSplits, 2);
  assert.equal(result.source, "capacity-estimate");
  assert.equal(result.plan.performance, null);
  assert.deepEqual(config, before);
  assert.throws(() => planTwoGpuLayers(config, value.id, {...weights, modelSha256: "c".repeat(64)}), /exact model/);
  assert.throws(() => planTwoGpuLayers(config, value.id, {...weights, layerBytes: [1]}), /one byte count/);
  assert.throws(() => planTwoGpuLayers(config, value.id, {...weights, firstStageExtraBytes: NaN}), /safe integer/);
  const tight = structuredClone(config);
  tight.groups[0].gpus[0].vramMiB = 5; // 3 MiB weights + 2 MiB fixed still needs nonzero KV.
  assert.throws(() => planTwoGpuLayers(tight, value.id, weights), /No two-GPU split fits/);
  const duplicate = structuredClone(config);
  duplicate.groups[0].gpus[1].id = duplicate.groups[0].gpus[0].id;
  assert.throws(() => planTwoGpuLayers(duplicate, value.id, weights), /already reserved/);
});

test("32B GQA model reserves 2 GiB KV for 8K context across all 64 layers", () => {
  const [result] = plan();
  assert.equal(result.kvMiB, 2048);
  assert.equal(result.requiredServerContextTokens, 8192);
  assert.equal(result.gpus[0].kvBytesPerToken, 131072);
  assert.equal(result.gpus[0].kvMiB, 1024);
  assert.equal(result.gpus[0].requiredMiB, 13072);
  assert.equal(result.gpus[0].headroomMiB, 3312);
  assert.equal(result.gpus[0].maxSlotsAtContext, 4);
  assert.equal(result.gpus[0].maxContextTokensPerSlot, 34688);
  assert.equal(result.gpus[1].layerStart, 32);
  assert.equal(result.gpus[1].layerEndExclusive, 64);
});

test("KV reservation scales with every slot and explicit uneven layer assignments", () => {
  const value = group({ slots: 2, topology: "wan" });
  value.gpus[0].layers = 16;
  value.gpus[1].layers = 48;
  const [result] = plan(value);
  assert.equal(result.requiredServerContextTokens, 16384);
  assert.equal(result.kvMiB, 4096);
  assert.equal(result.gpus[0].kvMiB, 1024);
  assert.equal(result.gpus[1].kvMiB, 3072);
  assert.equal(result.gpus[1].layerStart, 16);
});

test("one overloaded stage is rejected even if aggregate VRAM is sufficient", () => {
  const value = group();
  value.gpus[0].vramMiB = 13071;
  value.gpus[1].vramMiB = 65536;
  assert.throws(() => plan(value), /exceeds VRAM.*spare VRAM on another stage/);
  value.gpus[0].vramMiB = 13072;
  assert.equal(plan(value)[0].gpus[0].headroomMiB, 0);
  value.slots = 2;
  assert.throws(() => plan(value), /exceeds VRAM/);
});

test("each physical GPU can only be reserved once within or across groups", () => {
  const duplicate = group();
  duplicate.gpus[1].id = duplicate.gpus[0].id;
  assert.throws(() => plan(duplicate), /already reserved/);
  const other = group({ id: "group-2", model: "other-model", endpoint: "http://127.0.0.1:8082" });
  assert.throws(() => planInferenceConfig({ version: 1, groups: [group(), other] }), /already reserved/);
  other.gpus = other.gpus.map((gpu) => ({ ...gpu, id: `other-${gpu.id}` }));
  assert.equal(planInferenceConfig({ version: 1, groups: [group(), other] }).length, 2);
});

test("group and endpoint identities cannot duplicate", () => {
  for (const field of ["id", "endpoint"]) {
    const first = group();
    const second = group({ id: "group-2", model: "other-model", endpoint: "http://127.0.0.1:8082" });
    second[field] = first[field];
    second.gpus = second.gpus.map((gpu) => ({ ...gpu, id: `other-${gpu.id}` }));
    assert.throws(() => planInferenceConfig({ version: 1, groups: [first, second] }), /duplicates|already reserved/);
  }
});

function warmGroups(overrides = {}) {
  const primary = group({quantization: "Q4_K_M", engineVersion: "b10964", hourlyCost: 2, ...overrides});
  const standby = structuredClone(primary);
  standby.id = "group-standby";
  standby.endpoint = "http://127.0.0.1:8082";
  standby.gpus = standby.gpus.map(gpu => ({...gpu, id: `standby-${gpu.id}`}));
  return [primary, standby];
}

function candidates(groups = warmGroups(), options = {}) {
  // The existing pair contracts remain unchanged when single-group offers are added.
  return planWorkspaceCandidates(planInferenceConfig({version: 1, groups}), options).filter(candidate => candidate.standbyGroupId !== null);
}

test("single-group offers need no standby capacity or cost and retain admission constraints", () => {
  const source = warmGroups({performance: measured()});
  const plans = planInferenceConfig({version: 1, groups: source});
  const offers = planWorkspaceCandidates(plans);
  assert.deepEqual(offers.map(item => item.id), ["group-1", "group-standby", "group-1~group-standby", "group-standby~group-1"]);
  const single = planWorkspaceCandidates([plans[0]], {maxHourlyCost: 2, minTokensPerSecond: 8})[0];
  assert.equal(single.standbyGroupId, null);
  assert.deepEqual(single.groupIds, ["group-1"]);
  assert.equal(single.totalHourlyCost, 2);
  assert.equal(single.performance.standby, null);
  assert.equal(single.selectable, true);
  for (const value of [single, single.groupIds, single.performance]) assert.ok(Object.isFrozen(value));
  assert.equal(planWorkspaceCandidates([plans[0]], {maxHourlyCost: 1}).length, 0);
  assert.equal(planWorkspaceCandidates([plans[0]], {minTokensPerSecond: 9}).length, 0);
  delete source[0].hourlyCost;
  const unknown = planInferenceConfig({version: 1, groups: [source[0]]});
  assert.equal(planWorkspaceCandidates(unknown)[0].selectable, false);
  assert.equal(planWorkspaceCandidates(unknown, {maxHourlyCost: 100}).length, 0);
});

function measured(overrides = {}) {
  return {source: "measured", firstTokenMs: 2500, tokensPerSecond: 8, completionRate: 0.98,
    measuredAt: "2026-09-22T10:00:00Z", samples: 20, conditions: {inputTokens: 1024, outputTokens: 128}, ...overrides};
}

test("a workspace pair includes standby price without a universal speed threshold", () => {
  const source = warmGroups();
  source[1].hourlyCost = 3;
  const [candidate, reversed] = candidates(source);
  assert.equal(candidate.id, "group-1~group-standby");
  assert.equal(candidate.primaryGroupId, "group-1");
  assert.equal(candidate.standbyGroupId, "group-standby");
  assert.deepEqual(candidate.groupIds, ["group-1", "group-standby"]);
  assert.equal(reversed.primaryGroupId, "group-standby");
  assert.equal(candidate.totalHourlyCost, 5);
  assert.equal(candidate.currency, "CR");
  assert.equal(candidate.selectable, true);
  assert.equal(candidate.performance.primary, null);
  assert.equal(candidate.modelSha256, source[0].modelSha256);
  assert.equal(candidate.quantization, "Q4_K_M");
  assert.equal(JSON.stringify(candidate).includes("127.0.0.1"), false);
  assert.equal(candidates(source, {maxHourlyCost: 5}).length, 2);
  assert.equal(candidates(source, {maxHourlyCost: 4.99}).length, 0);
  assert.equal(candidates(source, {model: "other-model"}).length, 0);
  assert.equal(candidates(source, {contextTokens: 16384}).length, 0);
  assert.equal(candidates([source[0]]).length, 0);
});

test("unknown prices stay unknown and different currencies never form a pair", () => {
  const source = warmGroups();
  delete source[1].hourlyCost;
  assert.equal(candidates(source)[0].totalHourlyCost, null);
  assert.equal(candidates(source)[0].selectable, false);
  assert.equal(candidates(source, {maxHourlyCost: 100}).length, 0);
  source[1].hourlyCost = 0;
  source[0].hourlyCost = 0;
  assert.equal(candidates(source, {maxHourlyCost: 0})[0].selectable, true);
  source[1].currency = "USD";
  assert.equal(candidates(source).length, 0);
});

test("same-model standby groups must preserve the exact deployment contract", () => {
  for (const changes of [{modelSha256: "c".repeat(64)}, {templateSha256: "c".repeat(64)},
    {quantization: "Q8_0"}, {engineVersion: "b10965"}, {contextTokens: 4096}]) {
    const source = warmGroups();
    Object.assign(source[1], changes);
    assert.throws(() => candidates(source), /identical model\/template hashes/);
  }
  const source = warmGroups();
  source[1].modelArchitecture.kvHeads = 4;
  assert.throws(() => candidates(source), /modelArchitecture/);
});

test("performance constraints apply to both groups and accept only measured values", () => {
  const source = warmGroups({performance: measured()});
  const conditions = {minTokensPerSecond: 8, maxFirstTokenMs: 2500, minCompletionRate: 0.98};
  assert.equal(candidates(source, conditions).length, 2);
  const observations = candidates(source, conditions)[0].performance.primary;
  assert.equal(observations.source, "measured");
  assert.equal(observations.samples, 20);
  assert.equal(observations.measuredAt, "2026-09-22T10:00:00.000Z");
  assert.equal(observations.conditions.modelSha256, source[0].modelSha256);
  assert.equal(observations.conditions.quantization, "Q4_K_M");
  assert.equal(observations.conditions.contextTokens, 8192);
  assert.equal(observations.conditions.topology, "lan");
  for (const changes of [{tokensPerSecond: 7.9}, {firstTokenMs: 2501}, {completionRate: 0.97},
    {source: "estimated", samples: 0, measuredAt: null}]) {
    source[1].performance = measured(changes);
    assert.equal(candidates(source, conditions).length, 0);
  }
  const estimate = candidates(source)[0].performance.standby;
  assert.equal(estimate.source, "estimated");
  assert.equal(estimate.samples, 0);
  assert.equal(estimate.measuredAt, null);
  delete source[1].performance;
  assert.equal(candidates(source, conditions).length, 0);
});

test("workspace prices, conditions and performance declarations validate their boundaries", () => {
  for (const hourlyCost of [-1, NaN, Infinity, "2", null])
    assert.throws(() => candidates(warmGroups({hourlyCost})), /hourlyCost/);
  for (const currency of ["usd", "CR/hour", "", 1])
    assert.throws(() => candidates(warmGroups({currency})), /currency/);
  for (const changes of [{source: "unknown"}, {firstTokenMs: -1}, {tokensPerSecond: NaN}, {completionRate: 2},
    {samples: 0}, {measuredAt: "yesterday"}, {measuredAt: "2026-09-22T10:00:00"}, {conditions: {inputTokens: 8192, outputTokens: 1}},
    {source: "estimated"}])
    assert.throws(() => candidates(warmGroups({performance: measured(changes)})), /performance/);
  assert.throws(() => candidates(warmGroups({quantization: undefined, performance: measured()})), /quantization/);
  assert.throws(() => candidates(warmGroups({engineVersion: undefined, performance: measured()})), /engineVersion/);
  for (const options of [{minTokensPerSecond: NaN}, {maxHourlyCost: "3"}, {maxFirstTokenMs: -1},
    {minCompletionRate: 1.1}, {contextTokens: 511}, {model: "bad model"}, {unknown: true}])
    assert.throws(() => candidates(warmGroups(), options), /condition/);
});

test("workspace candidates and nested measurement contracts are detached and frozen", () => {
  const source = warmGroups({performance: measured()});
  const conditions = {minTokensPerSecond: 8};
  const result = planWorkspaceCandidates(planInferenceConfig({version: 1, groups: source}), conditions);
  const candidate = result[0], observed = candidate.performance.primary;
  for (const value of [result, candidate, candidate.groupIds, candidate.performance, observed, observed.conditions, candidate.constraints])
    assert.equal(Object.isFrozen(value), true);
  source[0].performance.conditions.inputTokens = 32;
  conditions.minTokensPerSecond = 100;
  assert.equal(observed.conditions.inputTokens, 1024);
  assert.equal(candidate.constraints.minTokensPerSecond, 8);
});

test("only literal HTTP loopback origins can become an upstream endpoint", () => {
  for (const endpoint of [
    "http://192.168.0.1:8081", "http://provider.example:8081", "https://127.0.0.1:8081",
    "http://localhost:8081", "http://127.0.0.1.evil:8081", "http://user:pass@127.0.0.1:8081",
    "http://127.0.0.1:8081/v1", "http://127.0.0.1:8081?key=x", "http://127.0.0.1:8081#x",
    "http://2130706433:8081", "http://127.0.0.1:99999", "file:///tmp/server", "http://[::ffff:127.0.0.1]:8081",
  ]) assert.throws(() => plan(group({ endpoint })), /endpoint/);
  assert.equal(plan(group({ endpoint: "http://[::1]:8081/" }))[0].endpoint, "http://[::1]:8081");
});

test("all layers must be assigned exactly once and only supported backend contracts pass", () => {
  for (const count of [31, 33]) {
    const value = group();
    value.gpus[0].layers = count;
    assert.throws(() => plan(value), /Assign every layer exactly once/);
  }
  for (const overrides of [
    { backend: "vllm" }, { splitMode: "row" }, { topology: "public" },
    { modelSha256: "not-a-digest" }, { templateSha256: "c".repeat(63) }, { enabled: false },
  ]) assert.throws(() => plan(group(overrides)));
  for (const kvBytes of [1, 4, NaN]) {
    const value = group();
    value.modelArchitecture.kvBytes = kvBytes;
    assert.throws(() => plan(value), /only f16/);
  }
});

test("NaN, infinity, fractional, unsafe and out of bounds resource values are rejected", () => {
  for (const bad of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "8192"]) {
    for (const field of ["contextTokens", "slots"])
      assert.throws(() => plan(group({ [field]: bad })), /safe integer/);
    for (const field of ["vramMiB", "weightsMiB", "workspaceMiB", "reserveMiB", "layers"]) {
      const value = group();
      value.gpus[0][field] = bad;
      assert.throws(() => plan(value), /safe integer/);
    }
    for (const field of ["layers", "kvHeads", "headDim"]) {
      const value = group();
      value.modelArchitecture[field] = bad;
      assert.throws(() => plan(value), /safe integer/);
    }
  }
  for (const overrides of [{ slots: 17 }, { contextTokens: 511 }, { contextTokens: 131073 }])
    assert.throws(() => plan(group(overrides)), /safe integer/);
});

test("malformed containers and unsupported config versions fail with actionable errors", () => {
  for (const value of [null, [], { version: 2, groups: [] }, { version: 1, groups: [] },
    { version: 1, groups: Array(9).fill(group()) }, { version: 1, groups: [null] }])
    assert.throws(() => planInferenceConfig(value));
  for (const gpus of [null, [], Array(17).fill(group().gpus[0])])
    assert.throws(() => plan(group({ gpus })), /1..16 physical GPUs/);
  assert.throws(() => plan(group({ modelArchitecture: [] })), /must be an object/);
  assert.throws(() => plan(group({ id: "group\nname" })), /must contain/);
});

test("the normalized plan is deeply frozen, detached from config and excludes unrelated credentials", () => {
  const source = group();
  const result = planInferenceConfig({ version: 1, groups: [source], tenants: [{ keySha256: "secret" }] });
  for (const value of [result, result[0], result[0].modelArchitecture, result[0].gpus, ...result[0].gpus])
    assert.equal(Object.isFrozen(value), true);
  source.gpus[0].layers = 1;
  source.modelArchitecture.layers = 1;
  assert.equal(result[0].gpus[0].layers, 32);
  assert.equal(result[0].modelArchitecture.layers, 64);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.throws(() => { result[0].slots = 99; }, TypeError);
});
