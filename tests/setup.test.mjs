import test from "node:test";
import assert from "node:assert/strict";
import { parseModelContract, connectionConfig, setupProgress } from "../lib/relay/setup.mjs";
const model = { modelDigest: "a".repeat(64), runtime: "b".repeat(64), template: "c".repeat(64), context: 8192 };
const credential = { nodeId: "node-1", poolId: "local-owner", token: "a".repeat(72) };
test("GUI model export maps to model approval payload and ignores extra fields", () => {
  assert.deepEqual(parseModelContract({ ...model, command: "untrusted" }), { digest: model.modelDigest, runtime: model.runtime, template: model.template, context: 8192 });
  for (const bad of [null, [], { ...model, template: "bad" }, { ...model, context: 0 }])
    assert.throws(() => parseModelContract(bad));
});
test("connection export includes every GUI field with pinned model", () => {
  const config = connectionConfig({ coordinator: "http://127.0.0.1:8788", credential, model });
  assert.equal(config.node, credential.nodeId);
  assert.equal(config.pool, "local-owner");
  assert.equal(config.token, credential.token);
  assert.equal(config.context, 8192);
  assert.equal(config.model.digest, model.modelDigest);
  assert.equal(connectionConfig({ coordinator: "https://relay.example.org", credential, model }).coordinator, "https://relay.example.org");
});
test("connection export rejects unsafe transport and embedded credentials", () => {
  for (const coordinator of ["http://192.168.1.1:8788", "https://user:secret@relay.example.org", "file:///test", "https://relay.example.org/path", "https://relay.example.org#secret"])
    assert.throws(() => connectionConfig({ coordinator, credential, model }));
});

test("connection display metadata is optional and preserves the registered PC name", () => {
  const legacy = connectionConfig({ coordinator: "https://relay.example.org", credential, model });
  assert.equal(Object.hasOwn(legacy, "nodeName"), false);
  const config = connectionConfig({ coordinator: "https://relay.example.org", credential: { ...credential, nodeName: "  작업실 PC  " }, model });
  assert.equal(config.nodeName, "작업실 PC");
  assert.equal(config.version, 1);
  assert.equal(config.node, legacy.node);
  assert.equal(config.token, legacy.token);
  assert.equal(connectionConfig({ coordinator: "https://relay.example.org", credential: { ...credential, nodeName: "🖥".repeat(80) }, model }).nodeName, "🖥".repeat(80));
});

test("connection display metadata rejects malformed names without truncating identity", () => {
  for (const nodeName of [null, 7, [], "", "  ", "a".repeat(81), "🖥".repeat(81), "PC\nname", "PC\u0000", "PC\u007f", "PC\u0085"])
    assert.throws(() => connectionConfig({ coordinator: "https://relay.example.org", credential: { ...credential, nodeName }, model }), /PC 이름/);
});
test("onboarding completion follows server connection state, not a download or revoked node", () => {
  assert.equal(setupProgress([], []).step, 0);
  assert.equal(setupProgress([model], []).step, 1);
  assert.equal(setupProgress([model], [{ revoked: true, connected: true, status: "online" }]).step, 1);
  assert.equal(setupProgress([model], [{ connected: false, status: "online" }]).step, 2);
  assert.equal(setupProgress([model], [{ connected: true, status: "paused" }]).step, 2);
  assert.equal(setupProgress([model], [{ connected: true, status: "online" }]).step, 3);
});
