/**
 * End-to-end encryption primitives shared by fleetd (Node/Bun) and the mobile app
 * (React Native / Web). Pure TypeScript, zero Node-specific APIs.
 *
 * Design:
 * - Each node and each device holds a long-term X25519 identity keypair.
 * - Each task generates a fresh random 256-bit DEK (`taskKey`), sealed to every
 *   recipient (trusted target nodes + the user's own devices) via an
 *   authenticated ephemeral-static + static-static X25519 key wrap (Noise IK
 *   style `es + ss`), so the hub can neither decrypt nor forge tasks.
 * - Subkeys derived from `taskKey` via HKDF-SHA256 protect:
 *     - task metadata (`title`, `prompt`) with AAD `task:<project>`
 *     - node -> client events with AAD `event:<runId>:<seq>`
 *     - client -> node follow-up inputs with AAD `input:<runId>` + unique `msgId`
 *     - client -> node approval decisions with AAD `approval:<runId>:<approvalId>`
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { type EncryptedEventHint, FleetEvent, type RunStatus, SealedBox } from "./events.ts";

export const E2EE_VERSION = 1 as const;
export const E2EE_ALG = "x25519-xchacha20poly1305" as const;

/** Placeholder strings stored on the hub when a task/message is end-to-end encrypted. */
export const ENCRYPTED_TASK_TITLE = "[端到端加密任务]";
export const ENCRYPTED_PLACEHOLDER = "[encrypted]";

// ---- Zod wire schemas -------------------------------------------------------

export const WrappedKey = z.object({
  /** Key id of the recipient (`keyId(recipientPublicKey)`). */
  kid: z.string().min(1),
  /** Ephemeral X25519 public key (32 bytes, base64). */
  epk: z.string().min(1),
  /** Wrapped 32-byte task DEK + 16-byte tag, base64. */
  ct: z.string().min(1),
});
export type WrappedKey = z.infer<typeof WrappedKey>;

export const TaskE2EE = z.object({
  v: z.literal(1),
  alg: z.literal(E2EE_ALG),
  /** Sender (device) static X25519 public key (32 bytes, base64). */
  spk: z.string().min(1),
  /** Encrypted `{ title, prompt }`, AAD = `task:<project>`. */
  box: SealedBox,
  /** One wrapped DEK per recipient (trusted nodes + user's own devices). */
  keys: z.array(WrappedKey).min(1),
});
export type TaskE2EE = z.infer<typeof TaskE2EE>;

/** Payload encoded in `agentfleet-node key` QR code for out-of-band node verification. */
export const NodeTrustPayload = z.object({
  v: z.literal(1),
  type: z.literal("node-key"),
  nodeId: z.string().min(1),
  name: z.string().min(1),
  publicKey: z.string().min(1),
});
export type NodeTrustPayload = z.infer<typeof NodeTrustPayload>;

export interface KeyPair {
  /** Raw 32-byte X25519 private key, standard base64. */
  privateKey: string;
  /** Raw 32-byte X25519 public key, standard base64. */
  publicKey: string;
}

// ---- Encoding & randomness (runtime-agnostic) -------------------------------

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < len ? bytes[i + 1]! : 0;
    const c = i + 2 < len ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_CHARS[(n >>> 18) & 63]!;
    out += B64_CHARS[(n >>> 12) & 63]!;
    out += i + 1 < len ? B64_CHARS[(n >>> 6) & 63]! : "=";
    out += i + 2 < len ? B64_CHARS[n & 63]! : "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) throw new Error("invalid base64 length");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length * 3) / 4 - pad);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean.charCodeAt(i);
    const c1 = clean.charCodeAt(i + 1);
    const c2 = clean.charCodeAt(i + 2);
    const c3 = clean.charCodeAt(i + 3);
    const v0 = c0 < 128 ? B64_LOOKUP[c0]! : -1;
    const v1 = c1 < 128 ? B64_LOOKUP[c1]! : -1;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? B64_LOOKUP[c2]! : -1;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? B64_LOOKUP[c3]! : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) throw new Error("invalid base64 character");
    const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[p++] = (n >>> 16) & 255;
    if (c2 !== 61) out[p++] = (n >>> 8) & 255;
    if (c3 !== 61) out[p++] = n & 255;
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s: string) => enc.encode(s);

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

let customRandomBytes: ((n: number) => Uint8Array) | null = null;

/**
 * Optional override for environments without `globalThis.crypto.getRandomValues`
 * (e.g. older React Native runtimes can wire `expo-crypto`'s `getRandomBytes`).
 */
export function setRandomBytesProvider(fn: (n: number) => Uint8Array) {
  customRandomBytes = fn;
}

export function randomBytes(n: number): Uint8Array {
  if (customRandomBytes) return customRandomBytes(n);
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error("crypto.getRandomValues is unavailable");
  return c.getRandomValues(out);
}

// ---- Key management ---------------------------------------------------------

export function generateKeyPair(): KeyPair {
  const priv = randomBytes(32);
  const pub = x25519.getPublicKey(priv);
  return { privateKey: toBase64(priv), publicKey: toBase64(pub) };
}

export function isValidPublicKey(publicKey: string): boolean {
  try {
    return fromBase64(publicKey).length === 32;
  } catch {
    return false;
  }
}

/** Stable 16-hex-char identifier for a public key (used to match wrapped DEK slots). */
export function keyId(publicKey: string): string {
  return toHex(sha256(fromBase64(publicKey)).subarray(0, 8));
}

/** Human-verifiable 12-hex-char safety fingerprint, e.g. `A1B2-C3D4-E5F6`. */
export function keyFingerprint(publicKey: string): string {
  const h = toHex(sha256(fromBase64(publicKey)).subarray(0, 6)).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

// ---- Key wrapping (Noise IK style es + ss) ----------------------------------

const WRAP_SALT = utf8("agentfleet-e2ee-v1-wrap");
const SUBKEY_SALT = utf8("agentfleet-e2ee-v1-subkey");
const ZERO_NONCE = new Uint8Array(24);

function deriveWrapKey(dhES: Uint8Array, dhSS: Uint8Array, epk: Uint8Array, spk: Uint8Array, rpk: Uint8Array): Uint8Array {
  return hkdf(sha256, concat(dhES, dhSS), WRAP_SALT, concat(epk, spk, rpk), 32);
}

export function wrapKey(dek: Uint8Array, senderPriv: Uint8Array, recipientPub: Uint8Array): WrappedKey {
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");
  if (senderPriv.length !== 32 || recipientPub.length !== 32) throw new Error("X25519 keys must be 32 bytes");
  const senderPub = x25519.getPublicKey(senderPriv);
  const ePriv = randomBytes(32);
  const ePub = x25519.getPublicKey(ePriv);
  const dhES = x25519.getSharedSecret(ePriv, recipientPub);
  const dhSS = x25519.getSharedSecret(senderPriv, recipientPub);
  const kek = deriveWrapKey(dhES, dhSS, ePub, senderPub, recipientPub);
  const ct = xchacha20poly1305(kek, ZERO_NONCE, recipientPub).encrypt(dek);
  return { kid: keyId(toBase64(recipientPub)), epk: toBase64(ePub), ct: toBase64(ct) };
}

export function unwrapKey(slot: WrappedKey, recipientPriv: Uint8Array, senderPub: Uint8Array): Uint8Array {
  if (recipientPriv.length !== 32 || senderPub.length !== 32) throw new Error("X25519 keys must be 32 bytes");
  const recipientPub = x25519.getPublicKey(recipientPriv);
  const ePub = fromBase64(slot.epk);
  if (ePub.length !== 32) throw new Error("invalid ephemeral public key");
  const dhES = x25519.getSharedSecret(recipientPriv, ePub);
  const dhSS = x25519.getSharedSecret(recipientPriv, senderPub);
  const kek = deriveWrapKey(dhES, dhSS, ePub, senderPub, recipientPub);
  const dek = xchacha20poly1305(kek, ZERO_NONCE, recipientPub).decrypt(fromBase64(slot.ct));
  if (dek.length !== 32) throw new Error("invalid unwrapped DEK length");
  return dek;
}

// ---- Subkeys & AEAD ---------------------------------------------------------

function subkey(dek: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, dek, SUBKEY_SALT, utf8(info), 32);
}

export function sealJson(key: Uint8Array, value: unknown, aad: string): SealedBox {
  const nonce = randomBytes(24);
  const pt = utf8(JSON.stringify(value));
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(pt);
  return { n: toBase64(nonce), c: toBase64(ct) };
}

export function openJson<T = unknown>(key: Uint8Array, box: SealedBox, aad: string): T {
  const nonce = fromBase64(box.n);
  if (nonce.length !== 24) throw new Error("invalid nonce length");
  const pt = xchacha20poly1305(key, nonce, utf8(aad)).decrypt(fromBase64(box.c));
  return JSON.parse(dec.decode(pt)) as T;
}

// ---- High-level protocol helpers -------------------------------------------

const TaskSecret = z.object({ title: z.string(), prompt: z.string() });

/**
 * Encrypts `{ title, prompt }` with a fresh per-task DEK and wraps the DEK for
 * every recipient plus the sender itself (so the sender can always re-read the
 * task without storing per-task keys locally).
 */
export function encryptTaskPayload(
  payload: { title: string; prompt: string },
  sender: KeyPair,
  recipientPublicKeys: string[],
  project: string,
): { e2ee: TaskE2EE; dek: Uint8Array } {
  const dek = randomBytes(32);
  const senderPriv = fromBase64(sender.privateKey);
  const uniquePubs = [...new Set([sender.publicKey, ...recipientPublicKeys])];
  const keys = uniquePubs.map((pk) => wrapKey(dek, senderPriv, fromBase64(pk)));
  const box = sealJson(subkey(dek, "task-meta"), payload, `task:${project}`);
  return {
    dek,
    e2ee: { v: E2EE_VERSION, alg: E2EE_ALG, spk: sender.publicKey, box, keys },
  };
}

export function decryptTaskPayload(
  e2ee: TaskE2EE,
  recipient: KeyPair,
  project: string,
): { dek: Uint8Array; title: string; prompt: string; senderPublicKey: string } {
  const myKid = keyId(recipient.publicKey);
  const slot = e2ee.keys.find((k) => k.kid === myKid);
  if (!slot) throw new Error("本设备/节点没有此加密任务的密钥");
  const dek = unwrapKey(slot, fromBase64(recipient.privateKey), fromBase64(e2ee.spk));
  const raw = openJson(subkey(dek, "task-meta"), e2ee.box, `task:${project}`);
  const parsed = TaskSecret.parse(raw);
  return { dek, title: parsed.title, prompt: parsed.prompt, senderPublicKey: e2ee.spk };
}

export function encryptEvent(
  dek: Uint8Array,
  runId: string,
  seq: number,
  event: FleetEvent,
): Extract<FleetEvent, { type: "encrypted" }> {
  let hint: EncryptedEventHint = "other";
  let status: RunStatus | undefined;
  if (event.type === "approval.requested" || event.type === "approval.resolved") hint = event.type;
  else if (event.type === "run.status") {
    hint = "run.status";
    status = event.status;
  }
  const box = sealJson(subkey(dek, `run:n2c:${runId}`), event, `event:${runId}:${seq}`);
  return status ? { type: "encrypted", hint, status, box } : { type: "encrypted", hint, box };
}

export function decryptEvent(
  dek: Uint8Array,
  runId: string,
  seq: number,
  event: Extract<FleetEvent, { type: "encrypted" }>,
): FleetEvent {
  const raw = openJson(subkey(dek, `run:n2c:${runId}`), event.box, `event:${runId}:${seq}`);
  const parsed = FleetEvent.parse(raw);
  if (parsed.type === "encrypted") throw new Error("nested encrypted event is not allowed");
  return parsed;
}

const InputSecret = z.object({ text: z.string().min(1), msgId: z.string().min(1), ts: z.number() });

export function encryptInput(dek: Uint8Array, runId: string, text: string, msgId = toHex(randomBytes(12))): SealedBox {
  return sealJson(subkey(dek, `run:c2n:${runId}`), { text, msgId, ts: Date.now() }, `input:${runId}`);
}

export function decryptInput(dek: Uint8Array, runId: string, box: SealedBox): { text: string; msgId: string; ts: number } {
  return InputSecret.parse(openJson(subkey(dek, `run:c2n:${runId}`), box, `input:${runId}`));
}

const ApprovalSecret = z.object({ approvalId: z.string().min(1), optionId: z.string().min(1) });

export function encryptApproval(dek: Uint8Array, runId: string, approvalId: string, optionId: string): SealedBox {
  return sealJson(subkey(dek, `run:c2n:${runId}`), { approvalId, optionId }, `approval:${runId}:${approvalId}`);
}

export function decryptApproval(dek: Uint8Array, runId: string, approvalId: string, box: SealedBox): string {
  const parsed = ApprovalSecret.parse(openJson(subkey(dek, `run:c2n:${runId}`), box, `approval:${runId}:${approvalId}`));
  if (parsed.approvalId !== approvalId) throw new Error("approvalId mismatch");
  return parsed.optionId;
}
