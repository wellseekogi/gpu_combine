import test from "node:test";
import assert from "node:assert/strict";
import {fork} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdir,mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import {gunzipSync,brotliDecompressSync} from "node:zlib";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {readBody} from "../lib/relay/service.mjs";
import {bootAuditServer} from "./audit-server-helper.mjs";

test("bounded JSON parsing handles fragmented Unicode, malformed input and size limits", async () => {
  const expected = {message: "한글 😀", count: 12};
  const bytes = Buffer.from(JSON.stringify(expected));
  const body = new ReadableStream({start(output) {
    for (const byte of bytes) output.enqueue(Uint8Array.of(byte));
    output.close();
  }});
  assert.deepEqual(await readBody(new Request("http://localhost", {method: "POST", body, duplex: "half"})), expected);
  for (const bad of ["[]", "null", "{", "x".repeat(90001)]) {
    await assert.rejects(readBody(new Request("http://localhost", {method: "POST", body: bad})),
      error => error.status === (bad.length > 90000 ? 413 : 400));
  }
});

test("static files stream with validators; hashed assets cache while private responses do not", async t => {
  const server = await bootAuditServer();
  t.after(() => server.close());
  const page = await fetch(server.origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  const html = await page.text();
  assert.equal(Number(page.headers.get("content-length")), Buffer.byteLength(html));
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const response = await fetch(new URL(asset, server.origin));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const content = await response.arrayBuffer();
  assert.equal(content.byteLength, Number(response.headers.get("content-length")));
  const cached = await fetch(new URL(asset, server.origin), {headers: {"if-none-match": `"other", ${etag}`}});
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
  const strongCached = await fetch(new URL(asset, server.origin), {headers: {"if-none-match": etag.replace(/^W\//, "")}});
  assert.equal(strongCached.status, 304, "GET validators use weak comparison for strong or weak client tags");
  assert.equal((await strongCached.arrayBuffer()).byteLength, 0);
  const privateResponse = await fetch(server.origin + "/api/relay", {headers: {"if-none-match": "*"}});
  assert.equal(privateResponse.status, 401);
  assert.equal(privateResponse.headers.get("cache-control"), "no-store");
  await privateResponse.body.cancel();
  const missing = await fetch(server.origin + "/missing-file.js");
  assert.equal(missing.status, 404);
  await missing.body.cancel();
});

test("snapshot compression is lossless, negotiated, uncached and excludes credential/error responses",async t=>{
 const server=await bootAuditServer();t.after(()=>server.close());
 const login=await fetch(server.origin+"/api/login",{method:"POST",headers:{"content-type":"application/json","accept-encoding":"gzip"},body:JSON.stringify({token:server.admin})});
 assert.equal(login.headers.get("content-encoding"),null);
 const cookie=login.headers.get("set-cookie").split(";")[0];await login.body.cancel();
 const raw=(path,headers)=>new Promise((accept,reject)=>{
  const request=http.get(server.origin+path,{headers},response=>{
   const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.once("error",reject);
   response.once("end",()=>accept({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
  });request.once("error",reject);
 });
 const plain=await raw("/api/relay",{cookie,"accept-encoding":"identity"});
 for(const [encoding,compressed] of [["gzip","gzip"],["br, GZIP;q=0.5","br"],["br;q=0.2, gzip;q=0.8","gzip"],["*;q=0.5","br"],["gzip;q=0, *;q=1","br"],["br;q=0, gzip;q=0, *;q=1",undefined],["gzip;q=0.5, identity;q=1",undefined],["gzip;q=0.000",undefined],["gzip;q=2",undefined],["",undefined]]){
  const response=await raw("/api/relay",{cookie,"accept-encoding":encoding});
  assert.equal(response.status,200);assert.equal(response.headers["cache-control"],"no-store");
  assert.equal(response.headers.vary,"Accept-Encoding");
  assert.equal(response.headers["content-encoding"],compressed,encoding);
  assert.deepEqual(JSON.parse(compressed==="br"?brotliDecompressSync(response.body):compressed==="gzip"?gunzipSync(response.body):response.body),JSON.parse(plain.body));
  if(compressed)assert.ok(response.body.length<plain.body.length);
 }
 assert.equal((await raw("/api/relay",{cookie,"accept-encoding":"*;q=0"})).status,406);
 assert.equal((await raw("/api/relay",{cookie,"accept-encoding":"br;q=0,gzip;q=0,identity;q=0"})).status,406);
 const denied=await raw("/api/relay",{"accept-encoding":"gzip"});
 assert.equal(denied.status,401);assert.equal(denied.headers["content-encoding"],undefined);
 const user={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),name:"gzip member"};
 const register=await fetch(server.origin+"/api/member/register",{method:"POST",headers:{"content-type":"application/json","accept-encoding":"gzip"},body:JSON.stringify(user)});
 assert.equal(register.status,200);assert.equal(register.headers.get("content-encoding"),null);await register.body.cancel();
 const member=await raw("/api/member/me",{"x-relay-member":user.id,authorization:"Bearer "+user.token,"accept-encoding":"gzip"});
 assert.equal(member.status,200);assert.equal(member.headers["content-encoding"],"gzip");
 const decoded=gunzipSync(member.body).toString();
 assert.equal(JSON.parse(decoded).id,user.id);assert.ok(!decoded.includes(user.token));assert.ok(!decoded.includes("tokenHash"));
});

test("static stream bounds file growth, aborts truncation, and closes empty files normally", async t => {
  const root = resolve(import.meta.dirname, "..");
  await mkdir(resolve(root, "work"), {recursive: true});
  const folder = await mkdtemp(resolve(root, "work/static-growth-"));
  const webRoot = resolve(folder, "public");
  await mkdir(webRoot);
  const growing = resolve(webRoot, "growing.txt");
  const shrinking = resolve(webRoot, "shrinking.txt");
  await writeFile(growing, "A");
  await writeFile(shrinking, "AB");
  await writeFile(resolve(webRoot, "empty.txt"), "");
  // The test child changes size after the actual handler's fstat, before it creates
  // the read stream. This exercises the race deterministically over real HTTP.
  const bootstrap = resolve(folder, "bootstrap.mjs");
  await writeFile(bootstrap, `
    import fs from "node:fs/promises";
    import {syncBuiltinESMExports} from "node:module";
    const open = fs.open;
    fs.open = async (path, ...args) => {
      const file = await open(path, ...args);
      if (path === process.env.RELAY_TEST_GROW_FILE || path === process.env.RELAY_TEST_SHRINK_FILE) {
        const stat = file.stat.bind(file);
        file.stat = async (...args) => {
          const info = await stat(...args);
          if (path === process.env.RELAY_TEST_GROW_FILE) await fs.appendFile(path, "B");
          else await fs.truncate(path, 1);
          return info;
        };
      }
      return file;
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(pathToFileURL(resolve(root, "standalone/server.mjs")).href)});
  `);
  const child = fork(bootstrap, [], {
    cwd: root, windowsHide: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {...process.env, RELAY_ADMIN_TOKEN: randomBytes(32).toString("hex"), RELAY_PORT: "0",
      RELAY_HOST: "127.0.0.1", RELAY_DATA_DIR: resolve(folder, "data"), RELAY_WEB_ROOT: webRoot,
      RELAY_INFERENCE_CONFIG: "", RELAY_PUBLIC_ORIGIN: "", RELAY_SECURE_COOKIE: "0",
      RELAY_TRUST_PROXY: "0", RELAY_LAUNCH_LOGIN: "1", RELAY_TEST_GROW_FILE: growing,
      RELAY_TEST_SHRINK_FILE: shrinking},
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(accept => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => { clearTimeout(timer); accept(); });
      if (child.connected) child.send("relay:shutdown"); else child.kill();
    });
    await rm(folder, {recursive: true, force: true});
  });
  const origin = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error("Static test startup timed out: " + diagnostics)); }, 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(Error("Static test exited: " + code + " " + diagnostics)); });
    child.on("message", message => {
      if (message?.type === "relay:launch-ready") { clearTimeout(timer); accept(message.origin); }
    });
  });
  const address = new URL(origin);
  const rawRequest = request => new Promise((accept, reject) => {
    const socket = net.connect(Number(address.port), address.hostname);
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(Error("Static response timed out")));
    socket.on("data", data => chunks.push(data));
    socket.once("error", reject);
    socket.once("end", () => accept(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.write(request));
  });
  const raw = await rawRequest("GET /growing.txt HTTP/1.1\r\nHost: " + address.host + "\r\nConnection: close\r\n\r\n");
  const [headers, body] = raw.split("\r\n\r\n");
  assert.match(headers, /^HTTP\/1.1 200/);
  assert.match(headers, /content-length: 1\r?$/im);
  assert.equal(body, "A", "an appended byte must not escape the advertised response frame");
  assert.equal(await readFile(growing, "utf8"), "AB", "fault injection must grow the file after stat");
  const truncated = await rawRequest("GET /shrinking.txt HTTP/1.1\r\nHost: " + address.host + "\r\n\r\n" +
    "GET /empty.txt HTTP/1.1\r\nHost: " + address.host + "\r\nConnection: close\r\n\r\n").catch(error => {
      assert.equal(error.code, "ECONNRESET"); return "";
    });
  assert.ok((truncated.match(/HTTP\/1\.1/g) ?? []).length <= 1,
    "A short static body must close the connection before a pipelined response can corrupt its frame.");
  assert.equal(await readFile(shrinking, "utf8"), "A", "fault injection must truncate the file after stat");
  const empty = await fetch(origin + "/empty.txt");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal(await empty.text(), "");
});
