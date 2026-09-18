import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored ZIP entries keep the setup download self-contained without a native archiver.
export function zipFiles(files) {
  const local = [], central = [];
  let offset = 0;
  for (const {name, data} of files) {
    const filename = Buffer.from(name, "utf8"), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0x0021, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// Explicit payloads prevent connection tokens, preferences, models and local
// runtime installations from ever entering a published provider package.
export const PROVIDER_FILES = Object.freeze([
  "START-PROVIDER.cmd", "provider/provider.py", "provider/setup_gui.py",
  "provider/model_discovery.py", "provider/gguf_metadata.py",
  "provider/connection_discovery.py", "provider/distributed_runtime.py",
  "provider/runtime_discovery.py", "provider/update_launcher.py",
  "provider/update-config.json", "provider/version.json",
]);
export const PROVIDER_MANIFEST = "provider-manifest.json";
const sha256 = data => createHash("sha256").update(data).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");

// Stable bytes across Git checkouts keep a version immutable even when Windows
// and Linux use different working-tree line endings. CMD remains ASCII/CRLF.
export function normalizeProviderFile(name, data) {
  if (!PROVIDER_FILES.includes(name)) throw new Error("Unknown provider package file: " + name);
  const source = new TextDecoder("utf-8", {fatal: true}).decode(data).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (name.endsWith(".cmd")) {
    if ([...source].some(character => character.codePointAt(0) > 127)) throw new Error("Provider command launcher must be ASCII");
    return Buffer.from(source.replaceAll("\n", "\r\n"), "ascii");
  }
  return Buffer.from(source, "utf8");
}

export async function providerFileData(root, name) {
  if (!PROVIDER_FILES.includes(name)) throw new Error("Unknown provider package file: " + name);
  return normalizeProviderFile(name, await readFile(resolve(root, name)));
}

export function providerMetadata(config, version) {
  if (config?.schema !== 1 || typeof config.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      config.repository.split("/").some(part => part === "." || part === "..") ||
      config.release_tag_prefix !== "provider-v" || config.manifest_asset !== "relay-provider-manifest.json" ||
      config.archive_asset !== "relay-provider.zip") throw new Error("Invalid provider update configuration");
  if (typeof version?.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version.version))
    throw new Error("Provider version must be a stable major.minor.patch version");
  return {schema: 1, version: version.version, repository: config.repository,
    tag: config.release_tag_prefix + version.version};
}

export async function providerPackage(root) {
  const files = await Promise.all(PROVIDER_FILES.map(async name => ({name, data: await providerFileData(root, name)})));
  const byName = new Map(files.map(file => [file.name, file.data]));
  const config = JSON.parse(byName.get("provider/update-config.json").toString("utf8"));
  const version = JSON.parse(byName.get("provider/version.json").toString("utf8"));
  const metadata = providerMetadata(config, version);
  const manifest = {...metadata, files: Object.fromEntries(files.map(({name, data}) => [name, sha256(data)]))};
  const archive = zipFiles([...files, {name: PROVIDER_MANIFEST, data: jsonBytes(manifest)}]);
  const releaseManifest = {...manifest, archive: {name: config.archive_asset, sha256: sha256(archive), size: archive.length}};
  return {archive, manifest, releaseManifest, config};
}

export async function providerArchive(root) {
  return (await providerPackage(root)).archive;
}
