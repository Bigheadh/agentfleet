/** Pure URL helpers (no React Native imports; unit-tested). */

/** Normalize user input like "hub.local:8080/" into "http://hub.local:8080". */
export function normalizeHubUrl(input: string): string | null {
  let s = input.trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  // Regex instead of `new URL()` so we don't depend on the RN runtime's URL polyfill.
  const m = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)/i.exec(s);
  if (!m) return null;
  const [, scheme, host, path] = m;
  if (!host || !/^[\w.-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i.test(host)) return null;
  // Keep any path prefix (reverse-proxy deployments), drop trailing slashes.
  return `${scheme!.toLowerCase()}://${host}${path ?? ""}`.replace(/\/+$/, "");
}

/** ws(s):// URL for the client live socket. */
export function liveSocketUrl(hub: string, token: string): string {
  return `${hub.replace(/^http/i, "ws")}/ws/client?token=${encodeURIComponent(token)}`;
}

/** Contents of a scanned pairing QR code. */
export interface ParsedPairing {
  hub: string;
  code: string;
  name: string;
}

/**
 * Parse the QR payload `{v:1, hub, code, name}` (see PairingPayload in proto).
 * Validated by hand rather than with `PairingPayload.parse` so that the hub URL
 * check does not depend on `URL` being available in the JS runtime; the shape
 * is identical. Returns null for anything that isn't an AgentFleet pairing code.
 */
export function parsePairingQr(data: string): ParsedPairing | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1 || typeof o.hub !== "string" || typeof o.code !== "string" || !o.code) return null;
  const hub = normalizeHubUrl(o.hub);
  if (!hub) return null;
  return { hub, code: o.code, name: typeof o.name === "string" ? o.name : hub };
}
