// Static admission planning for manually provisioned llama.cpp layer groups.
// This validates declarations; it does not discover devices or attest a running server.
const MIB = 1024 * 1024;
const MAX_MIB = 1024 * 1024;

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${path} must be an object.`);
  return value;
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error(`${path} must be a safe integer between ${min} and ${max}.`);
  return value;
}

function number(value, path, min = 0, max = 1e9) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw Error(`${path} must be a finite number between ${min} and ${max}.`);
  return value;
}

function performance(raw, path, conditions) {
  if (raw === undefined) return null;
  object(raw, path);
  if (!["measured", "estimated"].includes(raw.source))
    throw Error(`${path}.source must be measured or estimated.`);
  if (!conditions.quantization || !conditions.engineVersion)
    throw Error(`${path} requires the group's quantization and engineVersion.`);
  const lengths = object(raw.conditions, `${path}.conditions`);
  const inputTokens = integer(lengths.inputTokens, `${path}.conditions.inputTokens`, 1, conditions.contextTokens);
  const outputTokens = integer(lengths.outputTokens, `${path}.conditions.outputTokens`, 1, conditions.contextTokens);
  if (inputTokens + outputTokens > conditions.contextTokens)
    throw Error(`${path}.conditions inputTokens + outputTokens exceeds contextTokens.`);
  const measured = raw.source === "measured";
  const samples = measured ? integer(raw.samples, `${path}.samples`, 1, 1000000) : 0;
  if (measured && (typeof raw.measuredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.measuredAt) || !Number.isFinite(Date.parse(raw.measuredAt))))
    throw Error(`${path}.measuredAt must be an ISO timestamp with a timezone.`);
  if (!measured && (raw.measuredAt != null || raw.samples !== undefined && raw.samples !== 0))
    throw Error(`${path}: estimated performance cannot declare measuredAt or measured samples.`);
  return Object.freeze({
    source: raw.source,
    firstTokenMs: number(raw.firstTokenMs, `${path}.firstTokenMs`),
    tokensPerSecond: number(raw.tokensPerSecond, `${path}.tokensPerSecond`),
    completionRate: number(raw.completionRate, `${path}.completionRate`, 0, 1),
    measuredAt: measured ? new Date(raw.measuredAt).toISOString() : null, samples,
    conditions: Object.freeze({...conditions, inputTokens, outputTokens}),
  });
}

function identifier(value, path) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value))
    throw Error(`${path} must contain 1..256 letters, digits, dots, underscores, colons, slashes or hyphens.`);
  return value;
}

function digest(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error(`${path} must be a lowercase SHA-256 digest of the exact deployed file.`);
  return value;
}

function endpoint(value, path) {
  // Literal loopback avoids DNS resolution and restricts the gateway's upstream.
  if (typeof value !== "string" || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(value))
    throw Error(`${path} must be an HTTP loopback origin, e.g. http://127.0.0.1:8081. Tunnel remote servers locally.`);
  try {
    return new URL(value).origin;
  } catch {
    throw Error(`${path} has an invalid port or address.`);
  }
}

/**
 * Validate a static, exclusive physical-GPU reservation and calculate f16 KV needs.
 * GPU entries are consecutive layer stages in listed order, never tensor shards.
 * contextTokens is per slot; llama.cpp's total context is slots * contextTokens.
 * Top-level tenant credentials are deliberately handled by the gateway separately.
 */
export function planInferenceConfig(config) {
  object(config, "inference config");
  if (config.version !== 1) throw Error("inference config.version must be 1.");
  if (!Array.isArray(config.groups) || config.groups.length < 1 || config.groups.length > 8)
    throw Error("inference config.groups must contain 1..8 groups.");

  const groupIds = new Set();
  const modelContracts = new Map();
  const reservedGpus = new Map();
  const endpoints = new Set();
  const groups = config.groups.map((raw, groupIndex) => {
    const path = `groups[${groupIndex}]`;
    object(raw, path);
    if (Object.hasOwn(raw, "enabled"))
      throw Error(`${path}.enabled is unsupported: every configured group reserves its GPUs. Remove inactive groups.`);
    const id = identifier(raw.id, `${path}.id`);
    const model = identifier(raw.model, `${path}.model`);
    if (groupIds.has(id)) throw Error(`${path}.id duplicates group ${id}.`);
    groupIds.add(id);
    if (raw.backend !== "llama.cpp") throw Error(`${path}.backend must be llama.cpp.`);
    if (raw.splitMode !== "layer")
      throw Error(`${path}.splitMode must be layer; this planner does not support tensor or row splitting.`);
    if (!["lan", "wan"].includes(raw.topology)) throw Error(`${path}.topology must be lan or wan.`);
    const upstream = endpoint(raw.endpoint, `${path}.endpoint`);
    if (endpoints.has(upstream)) throw Error(`${path}.endpoint is already reserved by another group.`);
    endpoints.add(upstream);
    const modelSha256 = digest(raw.modelSha256, `${path}.modelSha256`);
    const templateSha256 = digest(raw.templateSha256, `${path}.templateSha256`);
    const quantization = raw.quantization === undefined ? null : identifier(raw.quantization, `${path}.quantization`);
    const engineVersion = raw.engineVersion === undefined ? null : identifier(raw.engineVersion, `${path}.engineVersion`);
    const hourlyCost = raw.hourlyCost === undefined ? null : number(raw.hourlyCost, `${path}.hourlyCost`);
    const currency = raw.currency ?? "CR";
    if (typeof currency !== "string" || !/^[A-Z]{2,8}$/.test(currency))
      throw Error(`${path}.currency must contain 2..8 uppercase letters.`);
    const contextTokens = integer(raw.contextTokens, `${path}.contextTokens`, 512, 131072);
    const slots = integer(raw.slots, `${path}.slots`, 1, 16);
    const architecture = object(raw.modelArchitecture, `${path}.modelArchitecture`);
    const layers = integer(architecture.layers, `${path}.modelArchitecture.layers`, 1, 1024);
    const kvHeads = integer(architecture.kvHeads, `${path}.modelArchitecture.kvHeads`, 1, 1024);
    const headDim = integer(architecture.headDim, `${path}.modelArchitecture.headDim`, 1, 8192);
    if (architecture.kvBytes !== 2)
      throw Error(`${path}.modelArchitecture.kvBytes must be 2; only f16 K and V caches are supported.`);
    const contract = JSON.stringify({modelSha256, templateSha256, quantization, engineVersion, contextTokens, layers, kvHeads, headDim});
    if (modelContracts.has(model) && modelContracts.get(model) !== contract)
      throw Error(`${path}: groups serving model ${model} must have identical model/template hashes, quantization, engineVersion, contextTokens and modelArchitecture.`);
    modelContracts.set(model, contract);
    const observations = performance(raw.performance, `${path}.performance`, {
      model, modelSha256, quantization, engineVersion, contextTokens, topology: raw.topology,
    });
    if (!Array.isArray(raw.gpus) || raw.gpus.length < 1 || raw.gpus.length > 16)
      throw Error(`${path}.gpus must contain 1..16 physical GPUs.`);

    let assignedLayers = 0;
    const gpus = raw.gpus.map((gpu, gpuIndex) => {
      const gpuPath = `${path}.gpus[${gpuIndex}]`;
      object(gpu, gpuPath);
      const gpuId = identifier(gpu.id, `${gpuPath}.id`);
      if (reservedGpus.has(gpuId))
        throw Error(`${gpuPath}.id ${gpuId} is already reserved by ${reservedGpus.get(gpuId)}. Each physical GPU must have one globally unique ID and belong to one group.`);
      reservedGpus.set(gpuId, id);
      const vramMiB = integer(gpu.vramMiB, `${gpuPath}.vramMiB`, 1, MAX_MIB);
      const weightsMiB = integer(gpu.weightsMiB, `${gpuPath}.weightsMiB`, 1, MAX_MIB);
      const workspaceMiB = integer(gpu.workspaceMiB, `${gpuPath}.workspaceMiB`, 1, MAX_MIB);
      const reserveMiB = integer(gpu.reserveMiB, `${gpuPath}.reserveMiB`, 1, MAX_MIB);
      const stageLayers = integer(gpu.layers, `${gpuPath}.layers`, 1, layers);
      const layerStart = assignedLayers;
      assignedLayers += stageLayers;
      // BigInt keeps malformed extreme declarations from rounding into admission.
      const kvBytesPerToken = 2n * BigInt(stageLayers) * BigInt(kvHeads) * BigInt(headDim) * 2n;
      const kvBytes = BigInt(slots) * BigInt(contextTokens) * kvBytesPerToken;
      const baseMiB = weightsMiB + workspaceMiB + reserveMiB;
      const requiredBytes = BigInt(baseMiB) * BigInt(MIB) + kvBytes;
      if (requiredBytes > BigInt(vramMiB) * BigInt(MIB))
        throw Error(`${gpuPath} (${gpuId}) exceeds VRAM: weights/workspace/reserve ${baseMiB} MiB plus KV ${Number(kvBytes) / MIB} MiB > ${vramMiB} MiB. Reduce slots/context/layers or use more VRAM; spare VRAM on another stage cannot cover this GPU.`);
      const availableBytes = BigInt(vramMiB - baseMiB) * BigInt(MIB);
      const kvMiB = Number(kvBytes) / MIB;
      return Object.freeze({
        id: gpuId, vramMiB, weightsMiB, workspaceMiB, reserveMiB,
        layers: stageLayers, layerStart, layerEndExclusive: assignedLayers,
        kvBytesPerToken: Number(kvBytesPerToken), kvMiB,
        requiredMiB: baseMiB + kvMiB, headroomMiB: vramMiB - baseMiB - kvMiB,
        maxContextTokensPerSlot: Number(availableBytes / (BigInt(slots) * kvBytesPerToken)),
        maxSlotsAtContext: Number(availableBytes / (BigInt(contextTokens) * kvBytesPerToken)),
      });
    });
    if (assignedLayers !== layers)
      throw Error(`${path}.gpus assigns ${assignedLayers} layers but modelArchitecture.layers is ${layers}. Assign every layer exactly once in stage order.`);
    return Object.freeze({
      id, model, endpoint: upstream, backend: "llama.cpp", splitMode: "layer",
      modelSha256, templateSha256, contextTokens, slots, topology: raw.topology,
      quantization, engineVersion, hourlyCost, currency, performance: observations,
      requiredServerContextTokens: slots * contextTokens,
      modelArchitecture: Object.freeze({ layers, kvHeads, headDim, kvBytes: 2 }),
      gpus: Object.freeze(gpus), kvMiB: gpus.reduce((sum, gpu) => sum + gpu.kvMiB, 0),
    });
  });
  return Object.freeze(groups);
}

/**
 * Offline two-GPU placement: maximize the smaller stage's remaining VRAM.
 * Exact per-layer weight bytes belong to the pinned model, not a speed estimate.
 * Never reconfigure a running group or carry old performance across a new split.
 */
export function planTwoGpuLayers(config, groupId, weights) {
  object(config, "inference config");
  if (!Array.isArray(config.groups)) throw Error("inference config.groups must be an array.");
  const matches = config.groups.filter(group => group?.id === groupId);
  if (matches.length !== 1) throw Error("Select exactly one configured group.");
  const group = matches[0];
  if (!Array.isArray(group.gpus) || group.gpus.length !== 2)
    throw Error("Automatic layer placement currently requires exactly two GPUs.");
  object(weights, "weights");
  if (digest(weights.modelSha256, "weights.modelSha256") !== group.modelSha256)
    throw Error("Weight profile must match the group's exact model SHA-256.");
  const architecture = object(group.modelArchitecture, "modelArchitecture");
  const layers = integer(architecture.layers, "modelArchitecture.layers", 2, 1024);
  const kvHeads = integer(architecture.kvHeads, "modelArchitecture.kvHeads", 1, 1024);
  const headDim = integer(architecture.headDim, "modelArchitecture.headDim", 1, 8192);
  const slots = integer(group.slots, "slots", 1, 16);
  const context = integer(group.contextTokens, "contextTokens", 512, 131072);
  if (architecture.kvBytes !== 2) throw Error("Only f16 K and V caches are supported.");
  if (!Array.isArray(weights.layerBytes) || weights.layerBytes.length !== layers)
    throw Error("weights.layerBytes must contain one byte count per model layer.");
  const prefix = [0];
  for (const bytes of weights.layerBytes)
    prefix.push(prefix.at(-1) + integer(bytes, "weights.layerBytes[]", 1, MAX_MIB * MIB));
  // Include output/embedding tensors on the stages where the backend places them.
  const extras = ["firstStageExtraBytes", "lastStageExtraBytes"].map(key =>
    integer(weights[key], `weights.${key}`, 0, MAX_MIB * MIB));
  const budgets = group.gpus.map((gpu, index) => {
    object(gpu, `gpus[${index}]`);
    return BigInt(integer(gpu.vramMiB, "vramMiB", 1, MAX_MIB)
      - integer(gpu.workspaceMiB, "workspaceMiB", 1, MAX_MIB)
      - integer(gpu.reserveMiB, "reserveMiB", 1, MAX_MIB)) * BigInt(MIB);
  });
  const kvPerLayer = 4n * BigInt(slots) * BigInt(context) * BigInt(kvHeads) * BigInt(headDim);
  let best = null, feasibleSplits = 0;
  // ponytail: fixed two-GPU order, at most 1023 boundaries; measured latency can
  // rank these same legal boundaries later without changing the memory contract.
  for (let boundary = 1; boundary < layers; boundary++) {
    const counts = [boundary, layers - boundary];
    const weightMiB = [prefix[boundary] + extras[0], prefix[layers] - prefix[boundary] + extras[1]]
      .map(bytes => Math.ceil(bytes / MIB));
    const remaining = counts.map((count, i) => budgets[i] - BigInt(weightMiB[i]) * BigInt(MIB) - BigInt(count) * kvPerLayer);
    if (remaining.some(bytes => bytes < 0n)) continue;
    feasibleSplits++;
    const minimum = remaining[0] < remaining[1] ? remaining[0] : remaining[1];
    if (!best || minimum > best.minimum) best = {counts, weightMiB, minimum};
  }
  if (!best) throw Error("No two-GPU split fits weights, f16 KV, workspace and reserve. Reduce context/slots or supply more VRAM.");
  const updated = structuredClone(config);
  const selected = updated.groups.find(item => item.id === groupId);
  selected.gpus = selected.gpus.map((gpu, index) => ({...gpu, layers: best.counts[index], weightsMiB: best.weightMiB[index]}));
  delete selected.performance;
  const plans = planInferenceConfig(updated);
  return {config: updated, plan: plans.find(item => item.id === groupId), feasibleSplits, source: "capacity-estimate"};
}

/** Offer one running group, then optional warm-standby pairs; readiness is the gateway's job. */
export function planWorkspaceCandidates(plans, options = {}) {
  object(options, "workspace conditions");
  const allowed = new Set(["model", "contextTokens", "maxHourlyCost", "minTokensPerSecond", "maxFirstTokenMs", "minCompletionRate"]);
  if (Object.keys(options).some(key => !allowed.has(key))) throw Error("Unsupported workspace condition.");
  if (options.model !== undefined) identifier(options.model, "workspace conditions.model");
  if (options.contextTokens !== undefined) integer(options.contextTokens, "workspace conditions.contextTokens", 512, 131072);
  for (const key of ["maxHourlyCost", "minTokensPerSecond", "maxFirstTokenMs", "minCompletionRate"])
    if (options[key] !== undefined) number(options[key], `workspace conditions.${key}`, 0, key === "minCompletionRate" ? 1 : 1e9);
  const constraints = Object.freeze({...options});
  const constrainedPerformance = ["minTokensPerSecond", "maxFirstTokenMs", "minCompletionRate"].some(key => options[key] !== undefined);
  function satisfies(plan) {
    if (options.model !== undefined && plan.model !== options.model) return false;
    if (options.contextTokens !== undefined && plan.contextTokens < options.contextTokens) return false;
    const observed = plan.performance;
    if (!constrainedPerformance) return true;
    return observed?.source === "measured" &&
      (options.minTokensPerSecond === undefined || observed.tokensPerSecond >= options.minTokensPerSecond) &&
      (options.maxFirstTokenMs === undefined || observed.firstTokenMs <= options.maxFirstTokenMs) &&
      (options.minCompletionRate === undefined || observed.completionRate >= options.minCompletionRate);
  }
  const available = plans.filter(satisfies), candidates = [];
  for (const primary of available) {
    if (options.maxHourlyCost !== undefined && (primary.hourlyCost === null || primary.hourlyCost > options.maxHourlyCost)) continue;
    candidates.push(Object.freeze({
      id: primary.id, model: primary.model,
      primaryGroupId: primary.id, standbyGroupId: null, groupIds: Object.freeze([primary.id]),
      modelSha256: primary.modelSha256, templateSha256: primary.templateSha256,
      quantization: primary.quantization, engineVersion: primary.engineVersion, contextTokens: primary.contextTokens,
      totalHourlyCost: primary.hourlyCost, currency: primary.currency, selectable: primary.hourlyCost !== null,
      performance: Object.freeze({primary: primary.performance, standby: null}), constraints,
    }));
  }
  // ponytail: at most eight pre-provisioned groups; dynamic GPU assembly needs a separate deployment contract.
  for (const primary of available) for (const standby of available) {
    if (primary.id === standby.id || primary.model !== standby.model || primary.currency !== standby.currency) continue;
    const totalHourlyCost = primary.hourlyCost === null || standby.hourlyCost === null ? null : primary.hourlyCost + standby.hourlyCost;
    if (options.maxHourlyCost !== undefined && (totalHourlyCost === null || totalHourlyCost > options.maxHourlyCost)) continue;
    candidates.push(Object.freeze({
      id: `${primary.id}~${standby.id}`, model: primary.model,
      primaryGroupId: primary.id, standbyGroupId: standby.id,
      groupIds: Object.freeze([primary.id, standby.id]),
      modelSha256: primary.modelSha256, templateSha256: primary.templateSha256,
      quantization: primary.quantization, engineVersion: primary.engineVersion, contextTokens: primary.contextTokens,
      totalHourlyCost, currency: primary.currency, selectable: totalHourlyCost !== null,
      performance: Object.freeze({primary: primary.performance, standby: standby.performance}), constraints,
    }));
  }
  return Object.freeze(candidates);
}
