import {randomBytes, timingSafeEqual} from "node:crypto";

export const isLoopback = (host) => ["127.0.0.1", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"].includes(host?.toLowerCase());
export function validatedPublicOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error("RELAY_PUBLIC_ORIGIN must be a complete HTTPS origin."); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))) {
    throw new Error("RELAY_PUBLIC_ORIGIN must be an HTTPS origin without a path (HTTP is allowed only on loopback).");
  }
  return url.origin;
}
export function loopbackOrigin(address) {
  return `http://${address.family === "IPv6" ? "[::1]" : "127.0.0.1"}:${address.port}`;
}
export function directLaunchRequest(request, ip, origin) {
  if (!origin || !isLoopback(ip) || new URL(request.url).origin !== origin) return false;
  const source = request.headers.get("origin");
  if (source && source !== origin) return false;
  for (const name of request.headers.keys()) {
    if (name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip" || name === "via") return false;
  }
  return true;
}
export function createLaunchTicket({now = Date.now} = {}) {
  let token = randomBytes(32).toString("hex");
  const expiresAt = now() + 120000;
  return {
    token,
    consume(candidate) {
      if (!token || now() >= expiresAt || typeof candidate !== "string") return false;
      const actual = Buffer.from(token), offered = Buffer.from(candidate);
      if (actual.length !== offered.length || !timingSafeEqual(actual, offered)) return false;
      token = null;
      return true;
    },
  };
}
