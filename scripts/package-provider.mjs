#!/usr/bin/env node
// Usage: node scripts/package-provider.mjs [--root REPOSITORY] [--out DIRECTORY]
// Defaults: this repository and outputs/provider-release. No dependencies needed.
import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {providerPackage} from "../standalone/provider-archive.mjs";

export async function packageProvider({root = resolve(import.meta.dirname, ".."), out} = {}) {
  root = resolve(root);
  out = resolve(out ?? resolve(root, "outputs/provider-release"));
  const result = await providerPackage(root);
  await mkdir(out, {recursive: true});
  const archivePath = resolve(out, result.config.archive_asset);
  const manifestPath = resolve(out, result.config.manifest_asset);
  await writeFile(archivePath, result.archive);
  await writeFile(manifestPath, JSON.stringify(result.releaseManifest, null, 2) + "\n", "utf8");
  return {archivePath, manifestPath, manifest: result.releaseManifest};
}

export function packageOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--root", "--out"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--") ||
        Object.hasOwn(options, name.slice(2))) throw new Error("Usage: node scripts/package-provider.mjs [--root REPOSITORY] [--out DIRECTORY]");
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await packageProvider(packageOptions(process.argv.slice(2)));
    console.log(`${result.manifest.tag}: ${result.archivePath} (${result.manifest.archive.size} bytes)`);
    console.log(result.manifestPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
