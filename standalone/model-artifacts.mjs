import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import {mkdir, open, rename, rm, statfs} from "node:fs/promises";
import {resolve} from "node:path";
import {pipeline} from "node:stream/promises";
import {RelayError} from "../lib/relay/engine.mjs";

const GiB = 1024 ** 3;
const artifactId = /^[a-f0-9-]{36}$/;
const publicArtifact = row => ({id:row.id, name:row.name, digest:row.digest, size:row.size});
const safeHash = (left, right) => typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

// Model bytes stay outside the public web root. Only their owner and the provider
// with a current, fenced execution grant can access an uploaded artifact.
export function createModelArtifacts({db, dataDir, store, maxFileBytes = 20 * GiB, maxMemberBytes = 40 * GiB, maxTotalBytes = 100 * GiB, now = Date.now}) {
  const directory = resolve(dataDir, "models");
  db.exec("CREATE TABLE IF NOT EXISTS relay_model_artifacts (id TEXT PRIMARY KEY NOT NULL, memberId TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, createdAt INTEGER NOT NULL)");
  const pending = new Map();
  const acquiring = new Map(), deleting = new Set();
  const filePath = id => resolve(directory, id + ".gguf");
  const get = id => typeof id === "string" && artifactId.test(id) ? db.prepare("SELECT * FROM relay_model_artifacts WHERE id=?").get(id) : null;
  const owned = (member, id) => {
    const row = get(id);
    if (!row || row.memberId !== member.id) throw new RelayError("내가 업로드한 모델을 선택하세요.", 404);
    return row;
  };
  const readBook = async () => {
    const row = await store.read("local-owner");
    return row ? JSON.parse(row.state).books.live : null;
  };
  const referenced = (job, id) => job.modelArtifact?.id === id;

  async function upload(request, member) {
    if (pending.has(member.id)) throw new RelayError("진행 중인 모델 업로드가 있습니다.", 409);
    const size = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size < 24) throw new RelayError("크기를 확인할 수 있는 GGUF 파일을 업로드하세요.", 411);
    if (size > maxFileBytes) throw new RelayError(`모델 파일은 ${maxFileBytes / GiB} GiB 이하여야 합니다.`, 413);
    let name;
    try { name = decodeURIComponent(request.headers.get("x-model-name") ?? ""); }
    catch { throw new RelayError("모델 파일 이름을 확인하세요."); }
    if (!name || name.length > 200 || !/\.gguf$/i.test(name) || /[\\/]/.test(name) || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new RelayError("GGUF 모델 파일을 선택하세요.");
    const total = db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM relay_model_artifacts").get().bytes;
    const memberTotal = db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM relay_model_artifacts WHERE memberId=?").get(member.id).bytes;
    const pendingBytes = [...pending.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (memberTotal + size > maxMemberBytes || total + pendingBytes + size > maxTotalBytes) throw new RelayError("모델 저장 공간이 부족합니다. 사용하지 않는 업로드를 삭제하세요.", 413);
    pending.set(member.id, size);
    const id = randomUUID(), temporary = resolve(directory, id + ".part");
    let handle, reader, bytes = 0, header = Buffer.alloc(0), complete = false;
    const digest = createHash("sha256");
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void reader?.cancel().catch(() => {}); }, 60 * 60 * 1000);
    timeout.unref();
    const abort = () => { void reader?.cancel().catch(() => {}); };
    request.signal.addEventListener("abort", abort, {once:true});
    try {
      await mkdir(directory, {recursive:true});
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < pendingBytes + size + 512 * 1024 ** 2) throw new RelayError("서버의 모델 저장 공간이 부족합니다.", 507);
      if (!request.body) throw new RelayError("모델 파일을 선택하세요.");
      handle = await open(temporary, "wx", 0o600);
      reader = request.body.getReader();
      async function* chunks() {
        while (true) {
          if (request.signal.aborted || timedOut) throw new RelayError("모델 업로드가 중단되었습니다.", 408);
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > size || bytes > maxFileBytes) throw new RelayError("모델 파일 크기가 업로드 정보와 다릅니다.", 413);
          if (header.length < 24) {
            header = Buffer.concat([header, Buffer.from(chunk.value.subarray(0, 24 - header.length))]);
            if (header.length >= 8 && (header.subarray(0, 4).toString("ascii") !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4)))) throw new RelayError("GGUF v2 또는 v3 모델 파일을 선택하세요.");
          }
          digest.update(chunk.value);
          yield chunk.value;
        }
        if (timedOut || request.signal.aborted || bytes !== size || header.length !== 24) throw new RelayError("모델 업로드가 완료되지 않았습니다. 다시 업로드하세요.", 400);
      }
      // Native writev batches bounded chunks and handles short writes; flush preserves fsync.
      const output = handle.createWriteStream({highWaterMark:256 * 1024, flush:true});
      output.once("error", abort); // Unblock a pending body read if the disk write fails.
      await pipeline(chunks(), output);
      handle = null;
      const row = {id, memberId:member.id, name, digest:digest.digest("hex"), size:bytes, createdAt:now()};
      await rename(temporary, filePath(id));
      db.prepare("INSERT INTO relay_model_artifacts(id,memberId,name,digest,size,createdAt) VALUES (?,?,?,?,?,?)").run(row.id,row.memberId,row.name,row.digest,row.size,row.createdAt);
      complete = true;
      return Response.json({artifact:publicArtifact(row)}, {status:201});
    } finally {
      clearTimeout(timeout); pending.delete(member.id);
      request.signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
      await handle?.close().catch(() => {});
      if (!complete) {
        await rm(temporary, {force:true});
        await rm(filePath(id), {force:true});
      }
    }
  }

  async function download(request, id) {
    const row = get(id);
    const book = await readBook();
    const node = book?.nodes.find(item => item.id === request.headers.get("x-relay-node"));
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token || !node || node.revoked || !safeHash(node.tokenHash, createHash("sha256").update(token).digest("hex"))) throw new RelayError("제공자 인증이 필요합니다.", 401);
    const authorized = async () => {
      const current = await readBook();
      const currentNode = current?.nodes.find(item => item.id === node.id);
      return row && currentNode?.status === "online" && !currentNode.revoked && current.jobs.some(job => referenced(job, id) && !job.cancelled && !job.archived && job.deadline > now() && (job.kind === "rental" && job.allowedNodes[0] === node.id && !job.finishedAt && currentNode.lastSeen > now() - 45000 || job.tasks.some(task => task.status === "leased" && task.lease.nodeId === node.id && task.lease.expiresAt > now())));
    };
    if (!await authorized()) throw new RelayError("이 GPU에 배정된 모델만 받을 수 있습니다.", 403);
    let handle;
    try { handle = await open(filePath(id), "r"); }
    catch { throw new RelayError("모델 파일을 찾을 수 없습니다. 다시 업로드하세요.", 404); }
    let controller, closed = false, closing, position = 0, checking = false, timer;
    const finish = error => {
      if (closed) return closing;
      closed = true;
      clearInterval(timer); request.signal.removeEventListener("abort", abort);
      if (error) controller.error(error);
      return closing = handle.close();
    };
    const abort = () => { void finish(new Error("Model download aborted")).catch(() => {}); };
    // Demand-driven reads avoid the Readable-to-Web adapter's extra buffer copy.
    const body = new ReadableStream({
      start(value) { controller = value; },
      async pull(value) {
        if (closed) return;
        try {
          const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, row.size - position));
          const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
          if (closed) return;
          if (!bytesRead) throw Error("Model file ended before its declared size");
          position += bytesRead;
          value.enqueue(buffer.subarray(0, bytesRead));
          if (position === row.size) { value.close(); await finish(); }
        } catch (error) { await finish(error); }
      },
      cancel() { return finish(); }
    }, {highWaterMark:0});
    timer = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try { if (!await authorized()) await finish(new Error("Model execution grant ended")); }
      catch { await finish(new Error("Cannot verify model execution grant")).catch(() => {}); }
      finally { checking = false; }
    }, 1000);
    timer.unref();
    request.signal.addEventListener("abort", abort, {once:true});
    if (request.signal.aborted) abort();
    return new Response(body, {headers:{"Content-Type":"application/octet-stream", "Content-Length":String(row.size), "X-Model-Sha256":row.digest}});
  }

  async function withOwned(member, id, operation) {
    const row = owned(member, id);
    if (deleting.has(id)) throw new RelayError("삭제 중인 모델은 실행할 수 없습니다.", 409);
    acquiring.set(id, (acquiring.get(id) ?? 0) + 1);
    try { return await operation(publicArtifact(row)); }
    finally {
      const remaining = acquiring.get(id) - 1;
      if (remaining) acquiring.set(id, remaining); else acquiring.delete(id);
    }
  }

  async function remove(member, id) {
    owned(member, id);
    if (acquiring.has(id) || deleting.has(id)) throw new RelayError("실행 요청 또는 삭제가 진행 중인 모델입니다.", 409);
    // Fence new job acquisition before the state read yields. Hold it until the
    // catalog and file deletion finish, including all failed-removal paths.
    deleting.add(id);
    try {
      const book = await readBook();
      if (book?.jobs.some(job => referenced(job, id) && (job.kind === "rental" && !job.finishedAt || job.tasks.some(task => ["ready", "leased"].includes(task.status))))) throw new RelayError("실행 중이거나 대기 중인 모델은 삭제할 수 없습니다.", 409);
      await rm(filePath(id), {force:true});
      db.prepare("DELETE FROM relay_model_artifacts WHERE id=? AND memberId=?").run(id, member.id);
      return Response.json({removed:true});
    } finally { deleting.delete(id); }
  }
  return {upload, download, remove, withOwned, getOwned:(member,id) => publicArtifact(owned(member,id)),
    list:member => ({artifacts:db.prepare("SELECT * FROM relay_model_artifacts WHERE memberId=? ORDER BY createdAt DESC LIMIT 100").all(member.id).map(publicArtifact), maxFileBytes})};
}
