import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {fork} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {resolve} from "node:path";
import {clientAddress} from "../standalone/client-address.mjs";

const root = resolve(import.meta.dirname, "..");
function incoming(value, extra = {}) {
  return {socket: {remoteAddress: "127.0.0.1"}, headers: {...extra, ...(value === undefined ? {} : {"x-real-ip": value})},
    rawHeaders: value === undefined ? [] : ["X-Real-IP", value]};
}

async function boot(t, trustProxy = "") {
  await mkdir(resolve(root, "work"), {recursive: true});
  const dataDir = await mkdtemp(resolve(root, "work/proxy-qa-"));
  const admin = randomBytes(32).toString("hex");
  const child = fork(resolve(root, "standalone/server.mjs"), [], {
    cwd: root, windowsHide: true, execArgv: [],
    env: {...process.env, RELAY_ADMIN_TOKEN: admin, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1",
      RELAY_TRUST_PROXY: trustProxy, RELAY_DATA_DIR: dataDir, RELAY_INFERENCE_CONFIG: "",
      RELAY_PUBLIC_ORIGIN: "", RELAY_SECURE_COOKIE: "0", RELAY_LAUNCH_LOGIN: "1"},
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", chunk => {output += chunk;});
  child.stderr.on("data", chunk => {output += chunk;});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(accept => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => {clearTimeout(timer); accept();});
      if (child.connected) child.send("relay:shutdown"); else child.kill();
    });
    await rm(dataDir, {recursive: true, force: true});
  });
  const info = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error("Proxy test startup timed out: " + output)), 10000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("exit", code => {clearTimeout(timer); reject(Error("Proxy test startup exited: " + code + ": " + output));});
    child.on("message", message => {
      if (message?.type === "relay:launch-ready") {clearTimeout(timer); accept(message);}
    });
  });
  const request = (path, {headers = {}, body} = {}) => new Promise((accept, reject) => {
    const req = http.request(new URL(path, info.origin), {
      method: body === undefined ? "GET" : "POST", headers: {"Content-Type": "application/json", ...headers},
    }, response => {
      response.resume();
      response.on("end", () => accept(response.statusCode));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return {info, admin, request};
}

test("direct connections ignore all claimed proxy client addresses by default", () => {
  for (const value of [undefined, "203.0.113.5", "127.0.0.1", "malformed", ["203.0.113.5", "203.0.113.6"]]) {
    assert.equal(clientAddress(incoming(value, {"x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.8"})), "127.0.0.1");
  }
});

test("trusted proxies require one valid X-Real-IP and canonicalize equivalent addresses", () => {
  assert.equal(clientAddress(incoming("203.0.113.5", {"x-forwarded-for": "127.0.0.1"}), true), "203.0.113.5");
  assert.equal(clientAddress(incoming("2001:0DB8:0000:0000:0000:0000:0000:0001"), true), "2001:db8::1");
  assert.equal(clientAddress(incoming("::ffff:203.0.113.5"), true), "203.0.113.5");
  assert.equal(clientAddress(incoming("::ffff:cb00:7105"), true), "203.0.113.5");
  for (const value of [undefined, "", "localhost", "203.0.113.5, 127.0.0.1", "203.0.113.5:443", "[2001:db8::1]", "fe80::1%eth0", " 203.0.113.5 ", ["203.0.113.5"]]) {
    assert.throws(() => clientAddress(incoming(value), true), error => error.status === 400);
  }
  const duplicated = incoming("203.0.113.5");
  duplicated.rawHeaders.push("x-real-ip", "203.0.113.5");
  assert.throws(() => clientAddress(duplicated, true), error => error.status === 400);
});

test("HTTP clients cannot evade default login limits with spoofed proxy headers", async t => {
  const server = await boot(t);
  assert.match(server.info.token, /^[a-f0-9]{64}$/);
  for (let i = 1; i <= 12; i++) {
    assert.equal(await server.request("/api/login", {
      headers: {"X-Real-IP": `203.0.113.${i}`, "X-Forwarded-For": `198.51.100.${i}`}, body: {token: "wrong"},
    }), 401);
  }
  assert.equal(await server.request("/api/login", {headers: {"X-Real-IP": "203.0.113.99"}, body: {token: server.admin}}), 429);
});

test("trusted proxy HTTP requests get separate limits and cannot claim local launch privileges", async t => {
  const server = await boot(t, "1");
  assert.equal(server.info.token, undefined);
  for (let i = 0; i < 12; i++) {
    assert.equal(await server.request("/api/login", {headers: {"X-Real-IP": "203.0.113.5"}, body: {token: "wrong"}}), 401);
  }
  assert.equal(await server.request("/api/login", {
    headers: {"X-Real-IP": "203.0.113.5", "X-Forwarded-For": "198.51.100.99"}, body: {token: server.admin},
  }), 429);
  assert.equal(await server.request("/api/login", {
    headers: {"X-Real-IP": "::ffff:203.0.113.5"}, body: {token: server.admin},
  }), 429);
  assert.equal(await server.request("/api/login", {
    headers: {"X-Real-IP": "203.0.113.6", "X-Forwarded-For": "203.0.113.5"}, body: {token: server.admin},
  }), 200);
  for (const ip of ["203.0.113.6", "127.0.0.1", "::1"]) {
    assert.equal(await server.request("/api/launch-login", {headers: {"X-Real-IP": ip}, body: {token: "a".repeat(64)}}), 403);
  }
  // The proxy's loopback socket must not bypass the remote inference HTTPS requirement.
  assert.equal(await server.request("/v1/models", {headers: {"X-Real-IP": "203.0.113.6"}}), 403);
});

test("trusted proxy HTTP rejects missing, malformed, and duplicated client IP headers", async t => {
  const server = await boot(t, "1");
  for (const headers of [{}, {"X-Forwarded-For": "203.0.113.5"}, {"X-Real-IP": "203.0.113.5, 203.0.113.6"},
    {"X-Real-IP": "not-an-ip"}, {"X-Real-IP": "203.0.113.5:443"}, {"X-Real-IP": ["203.0.113.5", "203.0.113.5"]}]) {
    assert.equal(await server.request("/api/login", {headers, body: {token: server.admin}}), 400);
  }
  assert.equal(await server.request("/api/login", {headers: {"X-Real-IP": "2001:db8::1"}, body: {token: server.admin}}), 200);
});
