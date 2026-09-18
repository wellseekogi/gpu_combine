import {execute} from "../lib/relay/service.mjs";

// A server-only timer. Provider polling still claims work; maintenance never runs
// live inference or creates a lease for an absent provider.
export function needsMaintenance(book, mode, now) {
  return book.jobs.some(job => !job.archived && job.tasks.some(task => {
    if (task.status !== "ready" && task.status !== "leased") return false;
    if (mode === "demo") return true;
    return job.deadline <= now || (task.status === "leased" && task.lease.expiresAt <= now);
  }));
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
        if (!row || closed) continue;
        result.pools++;
        const state = JSON.parse(row.state);
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
  }

  return {start, stop, runOnce};
}
