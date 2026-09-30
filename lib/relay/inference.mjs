import {createHash, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";
import {performance} from "node:perf_hooks";
import {RelayError} from "./engine.mjs";
import {planInferenceConfig, planWorkspaceCandidates} from "./inference-plan.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, status = 400) => { throw new RelayError(message, status); };

// A request may stop waiting while other tenants still need shared preparation.
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, {once: true});
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validCompletion(message, reason) {
  if (!object(message) || message.role !== "assistant" || !["stop", "length", "tool_calls"].includes(reason)) return false;
  if (message.content != null && typeof message.content !== "string") return false;
  if (message.reasoning_content !== undefined && typeof message.reasoning_content !== "string") return false;
  const calls = message.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 32 || calls.some(call =>
    !object(call) || !validId(call.id) || call.type !== "function" || !object(call.function) ||
    !validId(call.function.name) || typeof call.function.arguments !== "string"))) return false;
  const hasCalls = !!calls?.length;
  if ((reason === "tool_calls" && !hasCalls) || (hasCalls && reason === "stop")) return false;
  return typeof message.content === "string" || typeof message.reasoning_content === "string" || hasCalls;
}

// Parse SSE lines and events incrementally, including CRLF and UTF-8 splits.
// A DONE marker is meaningful only after one valid, finished assistant choice.
function completionEvents(collect = false) {
  let skipLF = false, data = null, event = "", done = false, reason = null;
  const pending = [], lineEnd = /\r\n|\r|\n/g;
  const message = {}, calls = [], metadata = {};
  const invalid = () => { throw Error("Invalid inference stream completion."); };
  const valid = reason => {
    // Materialize holes only at completion, so missing call indexes still fail.
    if (message.tool_calls) message.tool_calls = Array.from(calls);
    return validCompletion(message, reason);
  };
  function dispatch() {
    if (event === "error") invalid();
    event = "";
    if (data === null) return;
    const value = Array.isArray(data) ? data.join("\n") : data; data = null;
    if (done) invalid();
    if (value === "[DONE]") {
      if (!valid(reason)) invalid();
      done = true; return;
    }
    let payload;
    try { payload = JSON.parse(value); } catch { invalid(); }
    if (!object(payload) || Object.hasOwn(payload, "error") || !Array.isArray(payload.choices)) invalid();
    if (collect) for (const key of ["id", "created", "model", "usage"]) if (payload[key] !== undefined) metadata[key] = payload[key];
    if (payload.usage != null) {
      if (!object(payload.usage) || !Number.isSafeInteger(payload.usage.completion_tokens) || payload.usage.completion_tokens < 0) invalid();
      if (!collect) metadata.usage = {completion_tokens: payload.usage.completion_tokens};
    } else if (!collect && payload.usage === null) metadata.usage = null;
    // OpenAI-compatible usage events carry no choices after the final choice.
    if (!payload.choices.length && reason && payload.usage != null) return;
    if (payload.choices.length !== 1 || reason) invalid();
    const choice = payload.choices[0];
    if (!object(choice) || choice.index !== undefined && choice.index !== 0 || !object(choice.delta)) invalid();
    const delta = choice.delta;
    if (delta.role !== undefined) {
      if (delta.role !== "assistant") invalid();
      message.role = delta.role;
    }
    for (const key of ["content", "reasoning_content"]) {
      if (delta[key] != null) {
        if (typeof delta[key] !== "string") invalid();
        // Forwarded SSE needs presence/type validation, not a second full answer.
        message[key] = collect ? (message[key] ?? "") + delta[key] : message[key] || (delta[key] ? "x" : "");
      }
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 32) invalid();
      message.tool_calls = calls;
      for (const part of delta.tool_calls) {
        if (!object(part) || !Number.isInteger(part.index) || part.index < 0 || part.index >= 32) invalid();
        const call = calls[part.index] ??= {id: "", function: {name: "", arguments: ""}};
        if (part.id !== undefined) {
          if (typeof part.id !== "string") invalid();
          call.id += part.id;
          if (call.id.length > 80) invalid();
        }
        if (part.type !== undefined) {
          if (part.type !== "function") invalid();
          call.type = part.type;
        }
        if (part.function !== undefined) {
          if (!object(part.function)) invalid();
          for (const key of ["name", "arguments"]) {
            if (part.function[key] !== undefined) {
              if (typeof part.function[key] !== "string") invalid();
              if (collect || key === "name") call.function[key] += part.function[key];
              if (key === "name" && call.function.name.length > 80) invalid();
            }
          }
        }
      }
    }
    if (choice.finish_reason != null) {
      if (!valid(choice.finish_reason)) invalid();
      reason = choice.finish_reason;
    }
  }
  function line(value) {
    if (!value) { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    // Most engine events have one data line; only multiline events need an array.
    if (field === "data") {
      if (data === null) data = content;
      else if (Array.isArray(data)) data.push(content);
      else data = [data, content];
    }
    else if (field === "event") event = content;
  }
  function fragment(text) {
    if (!text) return;
    pending.push(text);
    // Balance fragments instead of rescanning/copying an unfinished long line.
    // This also bounds fragment references for byte-sized upstream writes.
    while (pending.length > 1 && pending.at(-2).length <= pending.at(-1).length) {
      const last = pending.pop();
      pending[pending.length - 1] += last;
    }
  }
  return {
    hasOutput: () => !!(message.content || message.reasoning_content || calls.length),
    result: () => ({...metadata, object: "chat.completion", choices: [{index: 0, message, finish_reason: reason}]}),
    push(text, final = false) {
      let start = 0;
      if (skipLF && text.length) { if (text[0] === "\n") start = 1; skipLF = false; }
      // LF is the usual engine format; native search avoids a match array per line.
      const lfOnly = text.indexOf("\r", start) < 0;
      lineEnd.lastIndex = start;
      for (;;) {
        const match = lfOnly ? null : lineEnd.exec(text);
        const end = lfOnly ? text.indexOf("\n", start) : match?.index ?? -1;
        if (end < 0) break;
        const part = text.slice(start, end);
        line(pending.length ? pending.join("") + part : part);
        pending.length = 0;
        start = lfOnly ? end + 1 : lineEnd.lastIndex;
        skipLF = !lfOnly && match[0] === "\r" && start === text.length;
      }
      fragment(text.slice(start));
      if (final) {
        if (pending.length || data !== null || event) invalid();
        if (!done) throw Error("Inference stream ended without [DONE].");
      }
    },
  };
}

// Construct a new body: llama.cpp accepts native options that could otherwise
// override max_tokens, slot ownership, model loading or remote media fetching.
export function inferenceBody(input) {
  if (!object(input)) fail("추론 요청은 JSON 객체여야 합니다.");
  const allowed = new Set(["model", "messages", "max_tokens", "temperature", "top_p", "seed", "stop", "tools", "tool_choice", "response_format", "stream", "session_id"]);
  if (Object.keys(input).some(key => !allowed.has(key))) fail("지원하지 않는 추론 옵션이 있습니다.");
  if (typeof input.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(input.model)) fail("모델 식별자를 확인하세요.");
  if (input.session_id !== undefined && !validId(input.session_id)) fail("session_id는 영문·숫자·밑줄·하이픈 1~80자입니다.");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 128) fail("전체 대화 기록을 messages에 전달하세요(최대 128개).");
  for (const message of input.messages) {
    if (!object(message) || !["system", "user", "assistant", "tool"].includes(message.role) ||
        Object.keys(message).some(key => !["role", "content", "reasoning_content", "tool_calls", "tool_call_id", "name"].includes(key))) fail("메시지 형식이 올바르지 않습니다.");
    if (typeof message.content !== "string" && !(message.role === "assistant" && message.content == null && (message.tool_calls || typeof message.reasoning_content === "string"))) fail("현재는 텍스트 메시지만 지원합니다.");
    if (message.tool_call_id !== undefined && (message.role !== "tool" || !validId(message.tool_call_id))) fail("tool_call_id를 확인하세요.");
    if (message.role === "tool" && !message.tool_call_id) fail("도구 결과에 tool_call_id가 필요합니다.");
    if (message.reasoning_content !== undefined && (message.role !== "assistant" || typeof message.reasoning_content !== "string")) fail("reasoning_content는 assistant의 텍스트 필드입니다.");
    if (message.name !== undefined && !validId(message.name)) fail("메시지 name을 확인하세요.");
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 32) fail("tool_calls를 확인하세요.");
      for (const call of message.tool_calls) {
        if (!object(call) || !validId(call.id) || call.type !== "function" || !object(call.function) ||
            !validId(call.function.name) || typeof call.function.arguments !== "string") fail("함수 호출 형식을 확인하세요.");
      }
    }
  }
  const maxTokens = input.max_tokens ?? 1024;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) fail("max_tokens는 1~32768 정수입니다.");
  for (const [key, max] of [["temperature", 2], ["top_p", 1]]) {
    if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > max)) fail(`${key} 범위를 확인하세요.`);
  }
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4294967295)) fail("seed 범위를 확인하세요.");
  if (input.stream !== undefined && typeof input.stream !== "boolean") fail("stream은 boolean입니다.");
  if (input.stop !== undefined && !(typeof input.stop === "string" || (Array.isArray(input.stop) && input.stop.length <= 8 && input.stop.every(x => typeof x === "string")))) fail("stop 형식을 확인하세요.");
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > 32 || input.tools.some(tool => !object(tool) || tool.type !== "function" || !object(tool.function) || !validId(tool.function.name) || (tool.function.parameters !== undefined && !object(tool.function.parameters)))) fail("tools에는 함수 정의를 최대 32개 전달하세요.");
  }
  if (input.tool_choice !== undefined && !(["none", "auto", "required"].includes(input.tool_choice) || (object(input.tool_choice) && input.tool_choice.type === "function" && validId(input.tool_choice.function?.name)))) fail("tool_choice 형식을 확인하세요.");
  if (input.response_format !== undefined && (!object(input.response_format) || !["text", "json_object", "json_schema"].includes(input.response_format.type))) fail("response_format 형식을 확인하세요.");
  const body = {...input};
  delete body.session_id;
  return {...body, max_tokens: maxTokens, stream: input.stream ?? false, n: 1};
}

async function boundedJson(response, maxBytes = 4 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); fail("추론 엔진이 요청을 거절했습니다. 그룹 설정과 실행 로그를 확인하세요.", 503); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); fail("추론 엔진의 응답 한도를 초과했습니다.", 503); }
    chunks.push(value);
  }
  const bytes = chunks.length === 1 ? Buffer.from(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength) : Buffer.concat(chunks, size);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("추론 엔진의 JSON 응답이 올바르지 않습니다.", 503); }
}

export function createInferenceGateway(config, {fetchImpl = fetch, clock = Date.now, monotonicClock = () => performance.now(), workspaceStore, providerStateStore} = {}) {
  const plans = config ? planInferenceConfig(config) : [];
  const timeoutMs = config?.requestTimeoutMs ?? 600000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw Error("requestTimeoutMs must be 1000..1800000.");
  const tenants = config?.tenants ?? [];
  if (!Array.isArray(tenants) || tenants.length > 64) throw Error("tenants must be an array of at most 64 tenants.");
  const ids = new Set(), keys = new Set();
  for (const tenant of tenants) {
    if (!object(tenant) || !validId(tenant.id) || tenant.id === "operator" || ids.has(tenant.id) ||
        typeof tenant.keySha256 !== "string" || !/^[a-f0-9]{64}$/.test(tenant.keySha256) || keys.has(tenant.keySha256) ||
        !Array.isArray(tenant.models) || !tenant.models.length || tenant.models.some(model => !plans.some(plan => plan.model === model)) ||
        !Number.isInteger(tenant.maxConcurrent) || tenant.maxConcurrent < 1 || tenant.maxConcurrent > 16) throw Error("Invalid tenant identity, key hash, models or maxConcurrent.");
    ids.add(tenant.id); keys.add(tenant.keySha256);
  }
  const groups = plans.map(plan => ({plan, status: "unchecked", epoch: randomUUID(), preparing: null,
    slots: Array.from({length: plan.slots}, (_, id) => ({id, owner: null, cacheOwner: null, cacheEmpty: false, busy: false, controller: null, touched: 0})),
    requests: 0, failures: 0, promptTokens: 0, outputTokens: 0, generationMs: 0, lastAssigned: 0, lastAttempt: null}));
  const providerKeys = new Map();
  for (const raw of config?.groups ?? []) for (const gpu of raw.gpus) {
    if (gpu.providerKeySha256 !== undefined) {
      if (typeof gpu.providerKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(gpu.providerKeySha256)) throw Error("GPU providerKeySha256 must be a lowercase SHA-256.");
      providerKeys.set(gpu.id, gpu.providerKeySha256);
    }
  }
  const providerStates = new Map(), workspaces = new Map();
  for (const saved of providerStateStore?.load() ?? []) {
    if (!providerKeys.has(saved.gpuId) || providerKeys.get(saved.gpuId) !== saved.keySha256) continue;
    if (!validId(saved.runtimeId) || !Number.isSafeInteger(saved.startedAt) || !["providing", "reclaiming", "released"].includes(saved.state)) throw Error("Invalid persisted GPU provider state.");
    providerStates.set(saved.gpuId, {runtimeId: saved.runtimeId, startedAt: saved.startedAt, state: saved.state});
  }
  const recoveryTimeoutMs = config?.recoveryTimeoutMs ?? 60000;
  if (!Number.isInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 1000 || recoveryTimeoutMs > 60000) throw Error("recoveryTimeoutMs must be 1000..60000.");
  let closed = false, dispatchSequence = 0;
  const operator = {id: "operator", models: plans.map(plan => plan.model), maxConcurrent: 16};

  function authenticate(authorization, workspaceId) {
    if (typeof authorization !== "string" || !/^Bearer [!-~]{32,256}$/.test(authorization)) fail("추론용 API 키가 필요합니다.", 401);
    const digest = Buffer.from(sha256(authorization.slice(7)), "hex");
    const tenant = tenants.find(item => timingSafeEqual(digest, Buffer.from(item.keySha256, "hex")));
    const space = workspaceId && workspaces.get(workspaceId);
    if (!tenant && space?.accessKeySha256 && timingSafeEqual(digest, Buffer.from(space.accessKeySha256, "hex"))) {
      const owner = space.ownerId === "operator" ? operator : tenants.find(item => item.id === space.ownerId);
      if (owner) return {...owner, workspaceOnly: workspaceId};
    }
    if (!tenant) fail("추론용 API 키를 확인하세요.", 401);
    return tenant;
  }
  function models(tenant) { return {object: "list", data: plans.filter((plan, index) => tenant.models.includes(plan.model) && plans.findIndex(item => item.model === plan.model) === index).map(plan => ({id: plan.model, object: "model", owned_by: "relay", context_tokens: plan.contextTokens}))}; }
  function snapshot() {
    return {enabled: groups.length > 0, groups: groups.map(group => ({id: group.plan.id, model: group.plan.model,
      topology: group.plan.topology, status: group.status, epoch: group.epoch, contextTokens: group.plan.contextTokens,
      slots: group.slots.length, active: group.slots.filter(slot => slot.busy).length, gpus: group.plan.gpus,
      workspaceId: group.workspaceId ?? null, providerStates: group.plan.gpus.map(gpu => ({gpuId: gpu.id, ...(providerStates.get(gpu.id) ?? {state: "unknown"})})),
      requests: group.requests, failures: group.failures, promptTokens: group.promptTokens, outputTokens: group.outputTokens, generationMs: group.generationMs,
      lastAttempt: group.lastAttempt})),
      candidates: candidates(operator), workspaces: [...workspaces.values()].filter(space => space.ownerId === operator.id).map(workspaceView),
      tenants: tenants.map(tenant => ({id: tenant.id, models: tenant.models, maxConcurrent: tenant.maxConcurrent}))};
  }
  async function call(group, path, body, signal) {
    return fetchImpl(group.plan.endpoint + path, {method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: {"Content-Type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async function erase(group, slot) {
    const result = await boundedJson(await call(group, `/slots/${slot.id}?action=erase`, {}, AbortSignal.timeout(5000)));
    if (result.id_slot !== slot.id || !Number.isInteger(result.n_erased) || result.n_erased < 0) fail("KV 슬롯 삭제 확인에 실패했습니다.", 503);
    slot.cacheOwner = null; slot.cacheEmpty = true;
  }
  function invalidate(group, reason) {
    group.status = "unavailable"; group.epoch = randomUUID();
    for (const slot of group.slots) { slot.cacheOwner = null; slot.cacheEmpty = false; slot.controller?.abort(reason); }
  }
  async function verify(group) {
      const signal = AbortSignal.timeout(10000);
      await boundedJson(await call(group, "/health", undefined, signal));
      const props = await boundedJson(await call(group, "/props", undefined, signal));
      if (props.total_slots !== group.plan.slots || props.default_generation_settings?.n_ctx !== group.plan.contextTokens ||
          typeof props.chat_template !== "string" || sha256(props.chat_template) !== group.plan.templateSha256) fail("실행 중인 엔진의 슬롯·문맥·템플릿이 승인한 그룹과 다릅니다.", 503);
      const modelList = await boundedJson(await call(group, "/v1/models", undefined, signal));
      if (modelList.data?.length !== 1 || modelList.data[0].id !== group.plan.model) fail("실행 중인 모델 alias가 그룹과 다릅니다.", 503);
  }
  async function prepare(group) {
    if (closed || !providerAvailable(group)) fail("제공자가 GPU를 회수했습니다. 다시 제공을 시작해야 합니다.", 503);
    if (group.preparing) return group.preparing;
    const epoch = group.epoch, ready = group.status === "ready";
    group.preparing = (async () => {
      await verify(group);
      if (closed || group.epoch !== epoch) fail("GPU 확인 중 제공 상태가 변경되었습니다.", 503);
      if (ready) return;
      const signal = AbortSignal.timeout(10000);
      const slots = await boundedJson(await call(group, "/slots", undefined, signal));
      if (closed || group.epoch !== epoch) fail("GPU 준비 중 제공 상태가 변경되었습니다.", 503);
      if (!Array.isArray(slots) || slots.length !== group.slots.length || slots.some((slot, i) => slot.id !== i || slot.is_processing)) fail("엔진 슬롯을 독점 확보하지 못했습니다. 기존 실행이 끝난 후 다시 시도하세요.", 503);
      for (const slot of group.slots) {
        await erase(group, slot);
        if (closed || group.epoch !== epoch) fail("GPU 준비 중 제공 상태가 변경되었습니다.", 503);
      }
      group.status = "ready";
    })();
    try { await group.preparing; }
    catch (error) { if (group.epoch === epoch) invalidate(group, error); throw error; }
    finally { group.preparing = null; }
  }

  async function complete(tenant, input, clientSignal, target) {
    if (closed) fail("추론 서비스가 종료 중입니다.", 503);
    if (tenant.workspaceOnly && tenant.workspaceOnly !== target?.workspaceId) fail("이 키는 해당 실행 공간에서만 사용할 수 있습니다.", 403);
    const body = inferenceBody(input);
    if (!tenant.models.includes(body.model)) fail("이 모델의 사용 권한이 없습니다.", 403);
    const matching = groups.filter(item => item.plan.model === body.model && (target ? item.plan.id === target.groupId && item.workspaceId === target.workspaceId : !item.workspaceId));
    if (!matching.length) fail("분산 추론 그룹을 먼저 설정하세요.", 404);
    const owner = tenant.id + ":" + JSON.stringify([body.model, target?.workspaceId ?? null, input.session_id ?? randomUUID()]);
    const allSlots = groups.flatMap(item => item.slots);
    if (allSlots.some(slot => slot.busy && slot.owner === owner)) fail("같은 세션의 응답이 아직 생성 중입니다.", 409);
    if (allSlots.filter(slot => slot.busy && slot.owner?.startsWith(tenant.id + ":")).length >= tenant.maxConcurrent) fail("사용자 동시 실행 한도입니다. 진행 중인 요청 완료 후 다시 시도하세요.", 429);
    const available = matching.filter(group => providerAvailable(group) && !(group.status === "unavailable" && group.slots.some(slot => slot.busy)));
    if (!available.length) fail("사용 가능한 GPU 그룹이 없습니다. 제공 상태와 정리를 확인하세요.", 503);
    const now = clock();
    const warm = (slot, at = clock()) => slot.cacheOwner !== null && at >= slot.touched && at - slot.touched < 300000;
    const reusable = slot => !slot.busy && slot.cacheOwner === owner && warm(slot, now);
    const disposable = group => group.slots.some(slot => !slot.busy && !warm(slot, now));
    const load = group => group.slots.filter(slot => slot.busy).length / group.slots.length;
    // Keep a warm session on its GPU; new sessions use ready capacity without
    // claiming that unmeasured LAN/WAN groups have comparable token throughput.
    const group = available.filter(group => group.slots.some(slot => !slot.busy)).sort((a, b) =>
      Number(b.slots.some(reusable)) - Number(a.slots.some(reusable)) ||
      Number(b.status === "ready") - Number(a.status === "ready") ||
      Number(a.status === "unavailable") - Number(b.status === "unavailable") ||
      Number(disposable(b)) - Number(disposable(a)) || load(a) - load(b) || a.lastAssigned - b.lastAssigned)[0];
    if (!group) fail("GPU 그룹의 KV 슬롯이 모두 사용 중입니다. 잠시 후 다시 시도하세요.", 429);
    // ponytail: fixed, exclusive GPU groups and bounded slots; add placement and
    // a tenant-fair queue when measured demand justifies dynamic provisioning.
    const slot = group.slots.find(reusable) ??
      group.slots.filter(item => !item.busy).sort((a, b) => Number(warm(a, now)) - Number(warm(b, now)) || a.touched - b.touched)[0];
    if (!slot) fail("GPU 그룹의 KV 슬롯이 모두 사용 중입니다. 잠시 후 다시 시도하세요.", 429);
    const controller = new AbortController();
    group.lastAssigned = ++dispatchSequence;
    slot.busy = true; slot.owner = owner; slot.controller = controller;
    let streamReader = null, needsCleanup = false, finishPromise;
    // A stalled SSE consumer may never call pull again. Reclaim independently
    // of downstream backpressure, after the engine acknowledges cache erase.
    const cleanupAbort = () => {
      if (streamReader) void streamReader.cancel().catch(() => {}).then(() => finish(false));
    };
    controller.signal.addEventListener("abort", cleanupAbort, {once: true});
    const abort = () => controller.abort();
    clientSignal?.addEventListener("abort", abort, {once: true});
    if (clientSignal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs); timer.unref?.();
    const started = clock();
    const attemptStarted = monotonicClock(), attempt = {outcome: null, prepareMs: null, inputValidationMs: null,
      kvEraseMs: null, backendFirstOutputMs: null, backendTotalMs: null, cleanupMs: null, totalMs: null};
    let backendStarted = null;
    function finish(success) {
      // Every caller waits for the same cleanup ACK, including stream abort races.
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        if (backendStarted !== null) attempt.backendTotalMs = Math.max(0, monotonicClock() - backendStarted);
        clearTimeout(timer); clientSignal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", cleanupAbort);
        if (!success) {
          group.failures++;
          // Read-only preflight never changes KV. Once generation is attempted,
          // wait for a separate 5-second erase ACK before releasing capacity.
          // Failed cleanup quarantines the group until every backend slot is idle.
          if (needsCleanup) {
            const cleanupStarted = monotonicClock();
            try { await erase(group, slot); } catch { invalidate(group); }
            finally { attempt.cleanupMs = Math.max(0, monotonicClock() - cleanupStarted); }
          }
        } else {
          group.requests++; group.generationMs += Math.max(0, clock() - started);
          // A sessionless caller cannot address this cache again. Failed preflight
          // must not extend the age of an untouched, previously successful cache.
          slot.cacheOwner = input.session_id ? owner : null; slot.touched = clock();
        }
        // Last settled attempt only; wall time includes consumer waits and cleanup,
        // never GPU compute time. Shared initial erases belong to prepareMs.
        attempt.outcome = success ? "success" : "failure";
        attempt.totalMs = Math.max(0, monotonicClock() - attemptStarted);
        group.lastAttempt = Object.freeze(attempt);
        slot.busy = false; slot.owner = null; slot.controller = null;
      })();
      return finishPromise;
    }
    try {
      controller.signal.throwIfAborted();
      let phaseStarted = monotonicClock();
      try { await abortable(prepare(group), controller.signal); }
      finally { attempt.prepareMs = Math.max(0, monotonicClock() - phaseStarted); }
      controller.signal.throwIfAborted();
      // llama.cpp b10964 handle_count_tokens only formats/tokenizes the prompt;
      // reject it before evicting an existing session or marking KV as modified.
      body.id_slot = slot.id; body.cache_prompt = false; body.stream = false;
      let count;
      phaseStarted = monotonicClock();
      try {
        const counted = await call(group, "/v1/chat/completions/input_tokens", body, controller.signal);
        if ([400, 422].includes(counted.status)) {
          await counted.body?.cancel();
          fail("모델이 입력 형식을 거절했습니다. 메시지·도구 설정을 확인하세요.", counted.status);
        }
        count = await boundedJson(counted);
        if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 1) fail("정확한 입력 토큰 수를 확인하지 못했습니다.", 503);
        if (count.input_tokens + body.max_tokens > group.plan.contextTokens) fail(`입력 ${count.input_tokens} + 출력 예약 ${body.max_tokens} 토큰이 문맥 ${group.plan.contextTokens}을 초과합니다. 기록을 임의로 자르지 않았습니다.`, 422);
      } finally {
        attempt.inputValidationMs = Math.max(0, monotonicClock() - phaseStarted);
      }
      controller.signal.throwIfAborted();
      const reuse = slot.cacheOwner === owner && warm(slot);
      if (!reuse && !slot.cacheEmpty) {
        // This bounded erase must settle before the slot can be reused, even if
        // its request was canceled while the acknowledgement was in flight.
        phaseStarted = monotonicClock();
        try { await erase(group, slot); } catch (error) { invalidate(group, error); throw error; }
        finally { attempt.kvEraseMs = Math.max(0, monotonicClock() - phaseStarted); }
      }
      controller.signal.throwIfAborted();
      needsCleanup = true;
      slot.cacheEmpty = false;
      const epoch = group.epoch;
      body.cache_prompt = reuse; body.stream = input.stream ?? false;
      backendStarted = monotonicClock();
      const response = await call(group, "/v1/chat/completions", body, controller.signal);
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 422].includes(response.status)) fail("모델이 생성 옵션을 거절했습니다. 도구·응답 형식·샘플링 설정을 확인하세요.", response.status);
        fail("분산 추론이 실패했습니다. GPU 그룹과 실행 로그를 확인하세요.", 503);
      }
      group.promptTokens += count.input_tokens;
      const headers = {"X-Relay-Group": group.plan.id, "X-Relay-Epoch": epoch, "Cache-Control": "no-store"};
      if (!body.stream) {
        const result = await boundedJson(response);
        if (controller.signal.aborted || group.epoch !== epoch) fail("실행이 중단되었습니다. 전체 기록으로 다시 요청하세요.", 503);
        const choice = result?.choices?.[0];
        if (!object(result) || Object.hasOwn(result, "error") || !Array.isArray(result.choices) || result.choices.length !== 1 ||
            !object(choice) || choice.index !== undefined && choice.index !== 0 || !validCompletion(choice.message, choice.finish_reason)) fail("추론 결과 형식이 올바르지 않습니다.", 503);
        if (Number.isSafeInteger(result.usage?.completion_tokens) && result.usage.completion_tokens >= 0) group.outputTokens += result.usage.completion_tokens;
        await finish(true);
        return Response.json(result, {headers});
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel(); fail("추론 엔진이 SSE 응답을 반환하지 않았습니다.", 503); }
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true}), events = completionEvents(!!target?.onComplete);
      streamReader = reader;
      if (controller.signal.aborted) { await reader.cancel(); fail("추론이 취소되었습니다.", 503); }
      let size = 0, firstOutput = false;
      return new Response(new ReadableStream({
        async pull(output) {
          try {
            const next = await reader.read();
            if (controller.signal.aborted || group.epoch !== epoch) throw Error("Inference interrupted; replay full history.");
            if (next.done) {
              events.push(decoder.decode(), true);
              const result = events.result();
              group.outputTokens += result.usage?.completion_tokens ?? 0;
              target?.onComplete?.(result);
              await finish(true); output.close(); return;
            }
            size += next.value.length;
            if (size > 4 * 1024 * 1024) throw Error("Inference stream limit exceeded.");
            events.push(decoder.decode(next.value, {stream: true}));
            if (!firstOutput && events.hasOutput()) {
              firstOutput = true; attempt.backendFirstOutputMs = Math.max(0, monotonicClock() - backendStarted);
              target?.onFirstOutput?.();
            }
            output.enqueue(next.value);
          } catch (error) {
            target?.onFailure?.();
            controller.abort(); await reader.cancel().catch(() => {}); await finish(false); output.error(error);
          }
        },
        async cancel() { controller.abort(); await reader.cancel().catch(() => {}); await finish(false); },
      }), {headers: {...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no"}});
    } catch (error) {
      target?.onFailure?.();
      await finish(false);
      if (error instanceof RelayError) throw error;
      fail("추론 연결이 중단되었거나 시간이 초과되었습니다. 전체 대화 기록으로 다시 요청하세요.", 503);
    }
  }
  function workspaceView(space) {
    return Object.fromEntries(["id", "name", "ownerId", "model", "candidateId", "primaryGroupId", "standbyGroupId", "activeGroupId",
      "status", "active", "endpoint", "totalHourlyCost", "currency", "contextTokens", "recoveries", "lastRecoveryMs", "lastError", "createdAt"]
      .map(key => [key, space[key]]));
  }
  function saveWorkspace(space) {
    workspaceStore?.save({...workspaceView(space), selectionHash: space.selectionHash, accessKeySha256: space.accessKeySha256});
  }
  const selectionHash = candidate => sha256(JSON.stringify([candidate, ...candidate.groupIds.map(id => plans.find(plan => plan.id === id))]));
  function providerAvailable(group) {
    return !group.plan.gpus.some(gpu => ["reclaiming", "released"].includes(providerStates.get(gpu.id)?.state));
  }
  function candidates(tenant) {
    return planWorkspaceCandidates(plans.filter(plan => tenant.models.includes(plan.model)))
      .filter(candidate => candidate.groupIds.every(id => {
        const group = groups.find(group => group.plan.id === id);
        return !group.workspaceId && providerAvailable(group);
      }));
  }
  function ownedWorkspace(tenant, id) {
    const space = workspaces.get(id);
    if (!space || space.ownerId !== tenant.id || tenant.workspaceOnly && tenant.workspaceOnly !== id) fail("실행 공간을 찾을 수 없습니다.", 404);
    if (!tenant.models.includes(space.model)) fail("이 모델의 사용 권한이 없습니다.", 403);
    return space;
  }
  function workspaceSnapshot(tenant) {
    return {enabled: !!groups.length, candidates: candidates(tenant), workspaces: [...workspaces.values()].filter(space => space.ownerId === tenant.id).map(workspaceView)};
  }
  // ponytail: at most one optional preloaded standby; replenish through a new selection
  // after recovery. Provisioning arbitrary hosts needs an authenticated installer.
  async function createWorkspace(tenant, input, signal) {
    if (closed) fail("추론 서비스가 종료 중입니다.", 503);
    if (tenant.workspaceOnly) fail("실행 공간 생성에는 사용자 API 키가 필요합니다.", 403);
    if (!object(input) || Object.keys(input).some(key => !["candidateId", "name"].includes(key)) ||
        typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || Array.from(input.name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail("실행 공간 이름과 구성을 확인하세요.");
    const candidate = candidates(tenant).find(item => item.id === input.candidateId);
    if (!candidate) fail("선택한 구성이 사용 중이거나 변경되었습니다. 목록을 새로고침하세요.", 409);
    if (!candidate.selectable) fail("선택한 GPU 그룹의 비용을 모두 설정한 구성을 선택하세요.", 409);
    if (workspaces.size >= 256 || [...workspaces.values()].filter(space => space.status !== "stopped").length >= 64) fail("실행 공간 수 한도입니다.", 429);
    const selected = candidate.groupIds.map(id => groups.find(group => group.plan.id === id));
    if (selected.some(group => group.slots.some(slot => slot.busy) || group.preparing)) fail("GPU 그룹의 기존 요청이 끝난 뒤 다시 시도하세요.", 409);
    signal?.throwIfAborted();
    const id = randomUUID(), controller = new AbortController(), accessKey = randomBytes(32).toString("hex");
    const space = {id, ownerId: tenant.id, name: input.name.trim(), model: candidate.model, candidateId: candidate.id,
      primaryGroupId: candidate.primaryGroupId, standbyGroupId: candidate.standbyGroupId, activeGroupId: candidate.primaryGroupId,
      contextTokens: candidate.contextTokens, totalHourlyCost: candidate.totalHourlyCost, currency: candidate.currency,
      endpoint: `/v1/workspaces/${id}/chat/completions`, status: "preparing", active: false,
      recoveries: 0, lastRecoveryMs: null, lastError: null, createdAt: clock(), selectionHash: selectionHash(candidate), accessKeySha256: sha256(accessKey), controller};
    for (const group of selected) group.workspaceId = id;
    workspaces.set(id, space);
    let settle;
    space.pending = new Promise(resolve => { settle = resolve; });
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    try {
      saveWorkspace(space);
      // All preparation must settle before failed reservations can be released.
      const results = await Promise.allSettled(selected.map(prepare));
      controller.signal.throwIfAborted();
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      space.status = "ready"; saveWorkspace(space);
      return {...workspaceView(space), accessKey};
    } catch (error) {
      space.status = "stopped"; space.lastError = "선택한 GPU 그룹을 모두 준비하지 못했습니다.";
      for (const group of selected) if (!space.stopping && group.workspaceId === id) group.workspaceId = null;
      saveWorkspace(space);
      throw error;
    } finally { signal?.removeEventListener("abort", abort); space.controller = null; settle(); space.pending = null; }
  }
  async function stopWorkspace(tenant, id) {
    if (tenant.workspaceOnly) fail("실행 공간 종료에는 소유자 인증이 필요합니다.", 403);
    const space = ownedWorkspace(tenant, id);
    if (space.stopping) fail("실행 공간을 종료하고 있습니다.", 409);
    space.stopping = true;
    space.controller?.abort();
    await space.pending?.catch(() => {});
    const selected = groups.filter(group => group.workspaceId === id);
    // Preparation owns no generation slot, but must not race a new reservation.
    await Promise.allSettled(selected.map(group => group.preparing));
    for (const group of selected) {
      for (const slot of group.slots) {
        try { await erase(group, slot); } catch { invalidate(group); }
      }
      group.workspaceId = null;
    }
    space.status = "stopped"; space.active = false; space.stopping = false; saveWorkspace(space);
    return workspaceView(space);
  }
  function providerEvent(authorization, input) {
    if (!object(input) || !validId(input.runtimeId) || !Number.isSafeInteger(input.startedAt) || input.startedAt < 1 ||
        !["providing", "reclaiming", "released"].includes(input.state) || !Array.isArray(input.gpuIds) || !input.gpuIds.length || input.gpuIds.length > 16 || new Set(input.gpuIds).size !== input.gpuIds.length) fail("GPU 제공 상태 형식을 확인하세요.");
    const group = groups.find(group => group.plan.id === input.groupId);
    if (!group || typeof authorization !== "string" || !/^Bearer [!-~]{32,256}$/.test(authorization)) fail("GPU 제공자 인증이 필요합니다.", 401);
    const digest = Buffer.from(sha256(authorization.slice(7)), "hex");
    if (input.gpuIds.some(id => !group.plan.gpus.some(gpu => gpu.id === id) || !providerKeys.has(id) || !timingSafeEqual(digest, Buffer.from(providerKeys.get(id), "hex")))) fail("이 GPU의 제공 권한이 없습니다.", 403);
    let changed = false;
    for (const id of input.gpuIds) {
      const previous = providerStates.get(id);
      if (input.state === "providing") {
        if (previous && (input.startedAt <= previous.startedAt || input.runtimeId === previous.runtimeId)) continue;
      } else if (!previous || previous.runtimeId !== input.runtimeId || previous.startedAt !== input.startedAt || previous.state === "released") continue;
      const value = {state: input.state, runtimeId: input.runtimeId, startedAt: input.startedAt};
      providerStateStore?.save({gpuId: id, ...value, keySha256: providerKeys.get(id)});
      providerStates.set(id, value);
      changed = true;
    }
    if (changed) {
      invalidate(group, Error("GPU provider state changed."));
      for (const space of workspaces.values()) if (group.workspaceId === space.id && space.status !== "stopped") {
        if (space.activeGroupId === group.plan.id) space.status = space.active && space.standbyGroupId && space.activeGroupId !== space.standbyGroupId ? "recovering" : "unavailable";
        else space.status = "degraded";
        saveWorkspace(space);
      }
    }
    return {ok: true, ignored: !changed};
  }

  async function workspaceRequest(tenant, id, input, clientSignal) {
    const space = ownedWorkspace(tenant, id);
    const {restart_on_failure: restart, ...request} = input ?? {};
    if (restart !== undefined && typeof restart !== "boolean") fail("restart_on_failure는 boolean입니다.");
    inferenceBody(request);
    if (request.model !== space.model) fail("실행 공간의 모델은 변경할 수 없습니다.", 409);
    if (closed || space.status === "stopped" || space.stopping) fail("종료 중이거나 종료된 실행 공간입니다.", 410);
    if (space.invalid) fail("선택한 구성 조건이 변경되어 실행 공간을 다시 만들어야 합니다.", 409);
    if (space.active || space.status === "preparing" && space.controller) fail("이 실행 공간은 한 번에 요청 하나만 처리합니다.", 409);
    const controller = new AbortController(), requestId = randomUUID();
    const abort = () => controller.abort();
    clientSignal?.addEventListener("abort", abort, {once: true});
    if (clientSignal?.aborted) abort();
    space.active = true; space.controller = controller; space.lastError = null;
    let settle, reader, readerCancellation, recoveryTimer, resumeOutput, detectedAt = null, outputSeen = false, recovered = false;
    space.pending = new Promise(resolve => { settle = resolve; });
    const timeout = setTimeout(abort, timeoutMs); timeout.unref?.();
    const cancelReader = () => {
      resumeOutput?.();
      // A second reader.cancel() can settle before the first cleanup ACK.
      return readerCancellation ??= reader?.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancelReader);
    function finish() {
      clearTimeout(timeout); clearTimeout(recoveryTimer);
      controller.signal.removeEventListener("abort", cancelReader);
      clientSignal?.removeEventListener("abort", abort);
      space.active = false; space.controller = null;
      settle(); space.pending = null; saveWorkspace(space);
    }
    function firstOutput() {
      if (detectedAt !== null && !outputSeen) {
        outputSeen = true; space.lastRecoveryMs = Math.max(0, clock() - detectedAt);
        clearTimeout(recoveryTimer);
      }
    }
    async function generate(emit) {
      try {
        const standby = groups.find(group => group.plan.id === space.standbyGroupId);
        if (standby && space.activeGroupId !== space.standbyGroupId && standby.status === "unchecked") {
          await abortable(prepare(standby), controller.signal).catch(() => {});
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          let failedAt = null;
          try {
            controller.signal.throwIfAborted();
            // Observe actual first output even for JSON clients; the recovery
            // deadline limits restart latency, never a healthy long answer.
            let result;
            const response = await complete(tenant, {...request, stream: true}, controller.signal, {groupId: space.activeGroupId, workspaceId: id,
              onFirstOutput: firstOutput, onFailure: () => { failedAt ??= clock(); },
              ...(!request.stream && {onComplete: value => { result = value; }})});
            {
              reader = response.body.getReader();
              const chunks = [];
              for (;;) {
                const next = await reader.read();
                controller.signal.throwIfAborted();
                if (next.done) break;
                if (request.stream) { if (restart) await emit(next.value); else chunks.push(next.value); }
              }
              reader = null;
              if (request.stream && !restart) for (let i = 0; i < chunks.length; i++) {
                await emit(chunks[i]); chunks[i] = null;
              }
            }
            controller.signal.throwIfAborted();
            space.status = space.activeGroupId === space.primaryGroupId && (!standby || standby.status === "ready") ? "ready" : "degraded";
            space.lastError = null;
            if (request.stream && restart) await emit(new TextEncoder().encode(`event: relay.completed\ndata: ${JSON.stringify({requestId, attempt: attempt + 1})}\n\n`));
            return request.stream ? undefined : Response.json(result, {headers: {"X-Relay-Workspace": id, "X-Relay-Group": space.activeGroupId,
              "X-Relay-Recovered": String(recovered), "Cache-Control": "no-store"}});
          } catch (error) {
            await cancelReader(); reader = null; readerCancellation = null;
            if (controller.signal.aborted || !standby || attempt || space.activeGroupId === space.standbyGroupId || error instanceof RelayError && error.status !== 503) throw error;
            detectedAt = failedAt ?? clock(); outputSeen = false; space.lastRecoveryMs = null;
            space.status = "recovering"; space.activeGroupId = space.standbyGroupId; space.recoveries++; recovered = true;
            saveWorkspace(space);
            const remaining = recoveryTimeoutMs - Math.max(0, clock() - detectedAt);
            if (remaining <= 0) { controller.abort(); controller.signal.throwIfAborted(); }
            recoveryTimer = setTimeout(abort, remaining); recoveryTimer.unref?.();
            if (request.stream && restart) await emit(new TextEncoder().encode(`event: relay.restarting\ndata: ${JSON.stringify({requestId, attempt: 2, discard: true})}\n\n`));
          }
        }
      } catch (error) {
        space.status = controller.signal.aborted ? "degraded" : "unavailable";
        space.lastError = controller.signal.aborted ? "요청이 취소되었거나 복구·실행 시간이 초과되었습니다." : error.message;
        throw error;
      } finally { finish(); }
    }
    if (!request.stream) return generate();
    // Legacy clients receive only a fully validated attempt. Opt-in clients must
    // discard on relay.restarting and execute tools only after relay.completed.
    // The native one-chunk queue also applies pressure to empty upstream writes.
    // The native one-chunk queue also applies pressure to empty upstream writes.
    return new Response(new ReadableStream({
      start(output) {
        void generate(async chunk => {
          if (output.desiredSize <= 0) await new Promise(resolve => { resumeOutput = resolve; });
          resumeOutput = null;
          controller.signal.throwIfAborted();
          output.enqueue(chunk);
        }).then(() => { if (!controller.signal.aborted) output.close(); }, error => output.error(error));
      },
      pull() { resumeOutput?.(); },
      async cancel() { controller.abort(); await space.pending; },
    }), {headers: {"Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Relay-Workspace": id}});
  }

  for (const saved of workspaceStore?.load() ?? []) {
    if (!validId(saved.id) || !validId(saved.ownerId) || workspaces.size >= 256) throw Error("Invalid persisted workspace identity or capacity.");
    const candidate = planWorkspaceCandidates(plans).find(candidate => candidate.id === saved.candidateId);
    const space = {...saved, active: false, controller: null, pending: null};
    if (space.status !== "stopped") {
      const selected = candidate?.groupIds.map(id => groups.find(group => group.plan.id === id));
      const owner = saved.ownerId === "operator" ? operator : tenants.find(tenant => tenant.id === saved.ownerId);
      space.invalid = !owner?.models.includes(saved.model) || !candidate || saved.selectionHash !== selectionHash(candidate) || selected.some(group => group.workspaceId);
      space.status = space.invalid ? "unavailable" : "preparing";
      if (!space.invalid) for (const group of selected) group.workspaceId = space.id;
      else space.lastError = "저장된 GPU 구성·비용 조건이 현재 설정과 다릅니다.";
    }
    workspaces.set(space.id, space);
  }

  // ponytail: bounded, process-local retry receipts. Persist them alongside paid
  // rental settlement before promising durability or billing for inference.
  const receipts = new Map(), tenantReceiptCounts = new Map();
  let receiptBytes = 0, nextReceiptExpiry = Infinity;
  function forgetReceipt(key, receipt) {
    if (!receipts.delete(key)) return;
    receiptBytes -= receipt.response?.length ?? 0;
    const count = tenantReceiptCounts.get(receipt.tenantId) - 1;
    if (count) tenantReceiptCounts.set(receipt.tenantId, count); else tenantReceiptCounts.delete(receipt.tenantId);
  }
  async function idempotentComplete(tenant, input, signal, requestKey, run = complete, scope = "") {
    if (closed) fail("추론 서비스가 종료 중입니다.", 503);
    if (requestKey == null) return run(tenant, input, signal);
    if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestKey)) fail("Idempotency-Key는 영문·숫자·밑줄·하이픈 16~80자입니다.");
    if (input?.stream === true) fail("스트리밍 요청에서는 Idempotency-Key를 지원하지 않습니다. 끊긴 응답은 자동 재실행하지 마세요.");
    const key = tenant.id + ":" + scope + ":" + requestKey, fingerprint = sha256(JSON.stringify(input));
    const now = clock();
    if (now >= nextReceiptExpiry) {
      nextReceiptExpiry = Infinity;
      for (const [id, receipt] of receipts) if (!receipt.pending) {
        if (receipt.until <= now) forgetReceipt(id, receipt);
        else nextReceiptExpiry = Math.min(nextReceiptExpiry, receipt.until);
      }
    }
    const previous = receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
      if (!previous.response) fail("이 요청은 실행 중이거나 결과가 불확실합니다. 자동으로 다시 실행하지 않았습니다.", 409);
      return new Response(previous.response, {headers: {...previous.headers, "X-Relay-Duplicate": "true"}});
    }
    // Refuse more receipts instead of evicting a live fence within its TTL.
    if (receipts.size >= 4096 || (tenantReceiptCounts.get(tenant.id) ?? 0) >= 256) fail("재시도 보호 기록 한도입니다. 10분 후 다시 시도하세요.", 429);
    const receipt = {fingerprint, tenantId: tenant.id, pending: true, until: now + 600000};
    receipts.set(key, receipt);
    tenantReceiptCounts.set(tenant.id, (tenantReceiptCounts.get(tenant.id) ?? 0) + 1);
    try {
      const response = await run(tenant, input, signal);
      const result = new Uint8Array(await response.arrayBuffer());
      if (!closed && receiptBytes + result.length <= 8 * 1024 * 1024) {
        receipt.response = result; receipt.headers = Object.fromEntries(response.headers);
        receiptBytes += result.length;
      }
      return new Response(result, {headers: response.headers});
    } catch (error) {
      // Validation/admission failures did not reach an engine; allow a later retry.
      if (error instanceof RelayError && [400, 403, 404, 409, 422, 429].includes(error.status)) forgetReceipt(key, receipt);
      throw error;
    } finally {
      receipt.pending = false; receipt.until = clock() + 600000;
      if (receipts.has(key)) nextReceiptExpiry = Math.min(nextReceiptExpiry, receipt.until);
    }
  }
  function completeWorkspace(tenant, id, input, signal, key) {
    ownedWorkspace(tenant, id);
    return idempotentComplete(tenant, input, signal, key, (_tenant, body, requestSignal) => workspaceRequest(tenant, id, body, requestSignal), id);
  }
  function close() { closed = true; for (const space of workspaces.values()) space.controller?.abort(); for (const group of groups) invalidate(group); receipts.clear(); tenantReceiptCounts.clear(); receiptBytes = 0; nextReceiptExpiry = Infinity; }
  return {authenticate, operator, models, snapshot, complete: idempotentComplete, workspaceSnapshot, createWorkspace, stopWorkspace, completeWorkspace, providerEvent, close};
}
