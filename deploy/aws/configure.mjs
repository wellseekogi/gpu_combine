// Run with local Node.js before uploading, or with the Node container on EC2.
import {isIP} from "node:net";
import {writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

export function deploymentDomain(value) {
  if (typeof value !== "string" || !value) throw new Error("Provide the Elastic IPv4 address or an existing DNS hostname.");
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
      throw new Error("Use the public Elastic IPv4 address, not the private address.");
    return `gpu-together.${value}.sslip.io`;
  }
  const hostname = value.toLowerCase();
  if (hostname.length > 253 || !hostname.includes(".") || !/[a-z]/.test(hostname.split(".").at(-1)) ||
      !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new Error("Use a DNS hostname only, without https://, a port or a path.");
  return hostname;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node deploy/aws/configure.mjs ELASTIC_IP_OR_DOMAIN");
    const domain = deploymentDomain(process.argv[2]);
    await writeFile(resolve(import.meta.dirname, ".env"), `RELAY_DOMAIN=${domain}\n`, {flag: "wx", mode: 0o600});
    console.log(`Configured https://${domain}. Existing .env files are never overwritten.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
