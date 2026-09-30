import {isIP} from "node:net";
import {RelayError} from "../lib/relay/engine.mjs";

function normalizedAddress(value) {
  if (isIP(value) === 4) return value;
  // Scoped addresses are interface-local and cannot identify a public client.
  if (isIP(value) !== 6 || value.includes("%")) return null;
  const address = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
  if (!mapped) return address;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

// Opt in only behind a private reverse proxy that overwrites X-Real-IP.
// Requiring the header avoids silently treating a proxied request as local.
export function clientAddress(request, trustProxy = false) {
  if (!trustProxy) return request.socket.remoteAddress ?? "local";
  const value = request.headers["x-real-ip"];
  const copies = request.rawHeaders.filter((_, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === "x-real-ip").length;
  const address = copies === 1 && typeof value === "string" ? normalizedAddress(value) : null;
  if (!address) throw new RelayError("A single valid X-Real-IP header is required by the trusted proxy configuration.", 400);
  return address;
}
