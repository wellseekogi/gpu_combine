import {execute} from "../lib/relay/service.mjs";

// A server-only timer. Provider polling still claims work; maintenance never runs
// live inference or creates a lease for an absent provider.
export function needsMaintenance(book, mode, now) {
  return nextMaintenanceAt(book, mode) <= now;
}

function nextMaintenanceAt(book, mode) {
  let due = Infinity;
  let nodes;
  for (const job of book.jobs) {
    if (mode === "live" && job.kind === "rental" && !job.cancelled && !["closed", "failed"].includes(job.rentalStage)) {
      nodes ??= new Map(book.nodes.map(node => [node.id, node]));
      const node = nodes.get(job.allowedNodes[0]);
      if (!node || node.revoked || node.status !== "online") return -Infinity;
      due = Math.min(due, node.lastSeen + 45000);
    }
    if (job.archived) continue;
    for (const task of job.tasks) {
      if (task.status !== "ready" && task.status !== "leased") continue;
      if (mode === "demo") return -Infinity;
      if (job.deadline < due) due = job.deadline;
      if (task.status === "leased" && task.lease.expiresAt < due) due = task.lease.expiresAt;
    }
  }
  return due;
}

export function createMaintenanceScheduler({
  store,
  listPoolIds,
  intervalMs = 1000,
  maxPoolsPerRun = 16,
  clock = () => Date.now(),
  onError = () => {},
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) {
    throw new Error("Maintenance interval must be an integer between 1 and 60000 ms.");
  }
  if (!Number.isInteger(maxPoolsPerRun) || maxPoolsPerRun < 1 || maxPoolsPerRun > 64) {
    throw new Error("Maintenance batch must contain between 1 and 64 pools.");
  }
  let cursor = null;
  let active = null;
  let timer = null;
  let started = false;
  let closed = false;
  // Cache only revision and deadline, never a parsed state or credentials.
  const checked = new Map();

  function report(error, poolId = null) {
    try { onError(error, {poolId}); } catch { /* Logging must not stop recovery. */ }
  }

  async function batch() {
    const result = {pools: 0, ticks: 0, errors: 0};
    let ids;
    try {
      ids = await listPoolIds(cursor, maxPoolsPerRun);
      if (!Array.isArray(ids) || ids.length > maxPoolsPerRun || ids.some(id => typeof id !== "string")) {
        throw new Error("Invalid maintenance pool page.");
      }
    } catch (error) {
      result.errors++;
      report(error);
      return result;
    }
    cursor = ids.length === maxPoolsPerRun ? ids.at(-1) : null;
    for (const poolId of ids) {
      if (closed) break;
      try {
        const row = await store.read(poolId);
        if (!row || closed) { checked.delete(poolId); continue; }
        result.pools++;
        const prior = checked.get(poolId);
        if (prior && prior.revision === row.revision && clock() < prior.due) continue;
        const state = JSON.parse(row.state);
        const due = Math.min(nextMaintenanceAt(state.books.live, "live"), nextMaintenanceAt(state.books.demo, "demo"));
        checked.delete(poolId);
        if (Number.isSafeInteger(row.revision)) {
          if (checked.size >= 64) checked.delete(checked.keys().next().value);
          checked.set(poolId, {revision: row.revision, due});
        }
        for (const mode of ["live", "demo"]) {
          if (closed) break;
          if (!needsMaintenance(state.books[mode], mode, clock())) continue;
          // Use the same transactional CAS, budget checks and settlement fences
          // as API requests. A conflict reloads current state and current time.
          await execute(store, poolId, {
            mode, action: "tick", payload: {}, requestId: crypto.randomUUID(),
          }, {clock});
          result.ticks++;
        }
      } catch (error) {
        result.errors++;
        report(error, poolId);
      }
    }
    return result;
  }

  function runOnce() {
    if (closed) return Promise.resolve({pools: 0, ticks: 0, errors: 0});
    if (active) return active;
    active = Promise.resolve().then(batch).finally(() => { active = null; });
    return active;
  }

  async function loop() {
    timer = null;
    await runOnce();
    if (started && !closed) {
      timer = setTimeout(loop, intervalMs);
      timer.unref?.();
    }
  }

  function start() {
    if (started || closed) return;
    started = true;
    timer = setTimeout(loop, 0);
    timer.unref?.();
  }

  async function stop() {
    closed = true;
    started = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active) await active;
    checked.clear();
  }

  return {start, stop, runOnce};
}
