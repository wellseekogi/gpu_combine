#!/usr/bin/env node
// Usage: node scripts/package-server.mjs [--root REPOSITORY] [--out DIRECTORY]
// Build the web app first. The resulting ZIP needs no source checkout or npm install.
import {lstat, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {extname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {normalizeProviderFile, PROVIDER_FILES, zipFiles} from "../standalone/provider-archive.mjs";

const defaultRoot = resolve(import.meta.dirname, "..");
const usage = "Usage: node scripts/package-server.mjs [--root REPOSITORY] [--out DIRECTORY]";
const deployFiles = [
  "deploy/aws/Dockerfile", "deploy/aws/Dockerfile.dockerignore", "deploy/aws/compose.yaml",
  "deploy/aws/Caddyfile", "deploy/aws/aws.env.example", "deploy/aws/install-docker.sh",
  "deploy/aws/backup.sh", "deploy/aws/configure.mjs", "docs/aws-deployment-ko.md",
];
const publicFiles = ["favicon.svg", "provider.py", "gguf_metadata.py"];
const assetExtensions = new Set([
  ".js", ".mjs", ".css", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
]);
const privateDirectories = new Set(["node_modules", "private", "secrets", "models", "users", "runtimes"]);
const safeName = name => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

// Check every path component: checking only a leaf misses directory junctions
// and links that redirect otherwise allowlisted paths outside the checkout.
async function checkedPath(root, name, {directory = false} = {}) {
  let path = root;
  const parts = name ? name.split("/") : [];
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) path = resolve(path, parts[index]);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Refusing symbolic link in server package: " + (name || root));
    const needsDirectory = index < parts.length - 1 || directory;
    if (needsDirectory ? !info.isDirectory() : !info.isFile())
      throw new Error("Expected " + (needsDirectory ? "directory: " : "regular file: ") + (name || root));
  }
  return path;
}

export async function serverPackage(root = defaultRoot) {
  root = resolve(root);
  await checkedPath(root, "", {directory: true});
  const files = [];
  async function add(name, normalize = data => data) {
    const data = await readFile(await checkedPath(root, name));
    files.push({name, data: normalize(data)});
  }

  await add("package.json");
  for (const directory of ["standalone", "lib/relay"]) {
    const path = await checkedPath(root, directory, {directory: true});
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!safeName(entry.name) || extname(entry.name) !== ".mjs") continue;
      await add(directory + "/" + entry.name);
    }
  }
  if (!files.some(file => file.name === "standalone/server.mjs"))
    throw new Error("Missing server entry point: standalone/server.mjs");
  for (const name of PROVIDER_FILES) await add(name, data => normalizeProviderFile(name, data));
  // Linux shell scripts and config files must also survive Windows checkouts.
  for (const name of deployFiles) await add(name, data => Buffer.from(data.toString("utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n")));

  try {
    await add("standalone-dist/index.html");
    const assetsPath = await checkedPath(root, "standalone-dist/assets", {directory: true});
    async function addAssets(directory, path) {
      for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const name = directory + "/" + entry.name;
        if (entry.isSymbolicLink()) throw new Error("Refusing symbolic link in server package: " + name);
        if (!safeName(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!privateDirectories.has(entry.name.toLowerCase()))
            await addAssets(name, await checkedPath(root, name, {directory: true}));
        } else if (assetExtensions.has(extname(entry.name).toLowerCase())) await add(name);
      }
    }
    await addAssets("standalone-dist/assets", assetsPath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Missing web build. Run npm run build before packaging the server.", {cause: error});
    throw error;
  }
  if (!files.some(file => file.name.startsWith("standalone-dist/assets/") && /\.m?js$/.test(file.name)))
    throw new Error("Missing built JavaScript assets. Run npm run build before packaging the server.");
  for (const name of publicFiles) await add("standalone-dist/" + name);
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {archive: zipFiles(files), files: files.map(file => file.name)};
}

export async function packageServer({root = defaultRoot, out} = {}) {
  root = resolve(root);
  out = resolve(out ?? resolve(root, "outputs/aws-deploy"));
  const result = await serverPackage(root);
  await mkdir(out, {recursive: true});
  const archivePath = resolve(out, "relay-server.zip");
  await writeFile(archivePath, result.archive);
  return {archivePath, files: result.files, size: result.archive.length};
}

export function packageOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--root", "--out"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--") ||
        Object.hasOwn(options, name.slice(2))) throw new Error(usage);
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await packageServer(packageOptions(process.argv.slice(2)));
    console.log(`${result.archivePath} (${result.files.length} files, ${result.size} bytes)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
