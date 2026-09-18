import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {PROVIDER_FILES, PROVIDER_MANIFEST, normalizeProviderFile, providerFileData,
  providerMetadata, providerPackage} from "../standalone/provider-archive.mjs";
import {packageOptions} from "../scripts/package-provider.mjs";
const root = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
const hash = data => createHash("sha256").update(data).digest("hex");
const config = {schema: 1, repository: "wellseekogi/gpu_combine", release_tag_prefix: "provider-v",
  manifest_asset: "relay-provider-manifest.json", archive_asset: "relay-provider.zip"};

function archiveEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "Package entries are stored without compression");
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString("utf8");
    assert.equal(entries.has(name), false, "Duplicate archive entry " + name);
    const start = offset + 30 + length + extra;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), entries.size);
  return entries;
}

async function fixture(t, {crlf = false, bom = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relay-provider-package-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of PROVIDER_FILES) {
    const path = resolve(directory, name);
    await mkdir(dirname(path), {recursive: true});
    let source = name === "provider/update-config.json" ? JSON.stringify(config, null, 2) + "\n" :
      name === "provider/version.json" ? '{"version":"0.3.0"}\n' :
      name.endsWith(".cmd") ? "@echo off\nexit /b 0\n" : '# 임시 패키징 테스트\nprint("provider")\n';
    if (crlf) source = source.replaceAll("\n", "\r\n");
    await writeFile(path, (bom ? "\ufeff" : "") + source, "utf8");
  }
  return directory;
}

function verifyPackage(result) {
  const {archive, manifest, releaseManifest} = result;
  const entries = archiveEntries(archive);
  assert.deepEqual([...entries.keys()], [...PROVIDER_FILES, PROVIDER_MANIFEST]);
  assert.deepEqual(Object.keys(manifest.files), PROVIDER_FILES);
  assert.deepEqual(JSON.parse(entries.get(PROVIDER_MANIFEST)), manifest);
  assert.deepEqual(releaseManifest, {...manifest, archive: {name: "relay-provider.zip", sha256: hash(archive), size: archive.length}});
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(hash(entries.get(name)), expected, name + " content must match its manifest hash");
  }
  assert.equal(Object.hasOwn(manifest.files, PROVIDER_MANIFEST), false);
  return entries;
}

test("real provider package contains the complete allowlisted updater and validates every digest", async () => {
  const result = await providerPackage(root);
  const entries = verifyPackage(result);
  assert.equal(result.manifest.repository, "wellseekogi/gpu_combine");
  assert.equal(result.manifest.tag, "provider-v" + result.manifest.version);
  for (const name of PROVIDER_FILES) assert.deepEqual(entries.get(name), await providerFileData(root, name));
  assert.ok(entries.has("provider/update_launcher.py"));
  assert.ok(entries.has("provider/runtime_discovery.py"));
});

test("packaged scanner automatically finds managed runtimes outside the extracted setup bundle", async t => {
  const directory = await mkdtemp(join(tmpdir(), "relay-provider-discovery-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const entries = verifyPackage(await providerPackage(root));
  for (const [name, data] of entries) {
    const path = resolve(directory, name);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, data);
  }
  // Exercise the same isolated Windows drive fixture against the actual ZIP
  // payload. This catches a stale or incomplete scanner in release packages.
  await execute("python", ["-B", "-c", `
import importlib.util
from pathlib import Path
import sys
import unittest

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

checks = load("packaged_runtime_checks", Path(sys.argv[1]))
checks.module = load("packaged_runtime_discovery", Path(sys.argv[2]))
suite = unittest.TestSuite([checks.RuntimeDiscoveryTests(
    "test_windows_defaults_find_drive_project_from_separate_downloaded_helper")])
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and result.testsRun == 1 else 1)
`, resolve(root, "tests/runtime_discovery_test.py"), resolve(directory, "provider/runtime_discovery.py")],
  {cwd: directory, windowsHide: true, timeout: 30_000});
});
test("private connection data, preferences, models and runtime folders never enter the archive", async t => {
  const directory = await fixture(t);
  for (const name of [".env", ".relay/token", "provider/connection.json", "provider/provider-setup.json", "model.gguf", "runtimes/llama-server.exe"]) {
    await mkdir(dirname(resolve(directory, name)), {recursive: true});
    await writeFile(resolve(directory, name), "DO_NOT_PACKAGE_SECRET_VALUE");
  }
  const result = await providerPackage(directory);
  verifyPackage(result);
  assert.equal(result.archive.includes(Buffer.from("DO_NOT_PACKAGE_SECRET_VALUE")), false);
});

test("packages are identical across UTF-8 BOM and Windows or Unix checkout line endings", async t => {
  const unix = await fixture(t), windows = await fixture(t, {crlf: true, bom: true});
  const first = await providerPackage(unix), second = await providerPackage(windows);
  assert.deepEqual(first.archive, second.archive);
  assert.deepEqual(first.releaseManifest, second.releaseManifest);
  const entries = verifyPackage(first);
  assert.equal(entries.get("START-PROVIDER.cmd").toString(), "@echo off\r\nexit /b 0\r\n");
  assert.equal(entries.get("provider/provider.py").includes(Buffer.from("\r")), false);
  assert.equal(entries.get("provider/provider.py").subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
});

test("packaging fails if a required provider module is missing", async t => {
  const directory = await fixture(t);
  await unlink(resolve(directory, "provider/update_launcher.py"));
  await assert.rejects(providerPackage(directory), {code: "ENOENT"});
});

test("metadata and payload names reject invalid versions, assets and text encodings", () => {
  for (const version of ["0.3", "0.3.0-rc1", "01.3.0", "0.3.0/evil", 3, null, ["0.3.0"]])
    assert.throws(() => providerMetadata(config, {version}), /version/);
  for (const change of [{schema: 2}, {archive_asset: "../relay-provider.zip"}, {manifest_asset: "config.json"},
    {repository: "https://github.com/wellseekogi/gpu_combine"}, {repository: [config.repository]},
    {repository: "owner/.."}, {release_tag_prefix: "../"}])
    assert.throws(() => providerMetadata({...config, ...change}, {version: "0.3.0"}), /configuration/);
  assert.throws(() => normalizeProviderFile("../secrets", Buffer.from("secret")), /Unknown/);
  assert.throws(() => normalizeProviderFile("START-PROVIDER.cmd", Buffer.from("한글")), /ASCII/);
  assert.throws(() => normalizeProviderFile("provider/provider.py", Buffer.from([0xff, 0xfe])), /encoded data/);
});

test("package CLI writes exactly the release archive and manifest to a selected directory", async t => {
  const directory = await fixture(t);
  const out = resolve(directory, "release output");
  await execute(process.execPath, [resolve(root, "scripts/package-provider.mjs"), "--root", directory, "--out", out], {windowsHide: true});
  assert.deepEqual((await readdir(out)).sort(), [config.manifest_asset, config.archive_asset].sort());
  const archive = await readFile(resolve(out, config.archive_asset));
  const manifest = JSON.parse(await readFile(resolve(out, config.manifest_asset), "utf8"));
  assert.equal(manifest.archive.sha256, hash(archive));
  assert.equal(manifest.archive.size, archive.length);
  const inner = JSON.parse(archiveEntries(archive).get(PROVIDER_MANIFEST));
  const rest = {...manifest};
  delete rest.archive;
  assert.deepEqual(rest, inner);
});

test("package CLI rejects incomplete or unexpected arguments", () => {
  assert.deepEqual(packageOptions([]), {});
  assert.deepEqual(packageOptions(["--out", "release folder", "--root", "checkout"]), {out: "release folder", root: "checkout"});
  for (const args of [["--out"], ["--out", "--root"], ["--token", "secret"], ["--out", "first", "--out", "second"]])
    assert.throws(() => packageOptions(args), /Usage/);
});
