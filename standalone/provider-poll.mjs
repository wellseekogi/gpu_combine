import {RelayError} from "../lib/relay/engine.mjs";

// Process-local wakeups only. SQLite/CAS still authenticates and claims every job.
export function createProviderPollHub() {
  const versions = new Map(), pending = new Map();
  let closed = false;
  const version = poolId => versions.get(poolId) ?? 0;
  function notify(poolId) {
    if (closed) return;
    versions.set(poolId, version(poolId) + 1);
    for (const waiter of pending.values()) if (waiter.poolId === poolId) waiter.finish();
  }
  function wait(poolId, nodeId, observed, timeoutMs, signal) {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new RelayError("서버가 종료 중입니다.", 503));
    const key = poolId + ":" + nodeId;
    if (pending.has(key)) return Promise.reject(new RelayError("이 GPU의 작업 대기 요청이 이미 있습니다.", 409));
    if (version(poolId) !== observed || timeoutMs <= 0) return Promise.resolve();
    if (pending.size >= 20) return Promise.reject(new RelayError("GPU 작업 대기 요청 한도입니다.", 429));
    return new Promise((resolve, reject) => {
      const abort = () => finish(signal.reason);
      const finish = error => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(key);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(finish, timeoutMs); timer.unref?.();
      pending.set(key, {poolId, finish});
      signal?.addEventListener("abort", abort, {once: true});
    });
  }
  function close() {
    closed = true;
    for (const waiter of pending.values()) waiter.finish(new RelayError("서버가 종료 중입니다.", 503));
    versions.clear();
  }
  return {version, notify, wait, close};
}
