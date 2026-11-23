/** Persistent X25519 identity keypair for a fleetd node (mode 0600). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromBase64, generateKeyPair, isValidPublicKey, type KeyPair } from "@agentfleet/proto";
import { AGENTFLEET_HOME } from "./config.ts";

export function defaultIdentityPath(nodeId: string): string {
  return join(AGENTFLEET_HOME, "state", `identity-${nodeId}.key`);
}

export function loadOrCreateIdentity(keyPath: string): KeyPair {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<KeyPair>;
    if (
      typeof raw.privateKey === "string" &&
      typeof raw.publicKey === "string" &&
      isValidPublicKey(raw.publicKey) &&
      fromBase64(raw.privateKey).length === 32
    ) {
      return { privateKey: raw.privateKey, publicKey: raw.publicKey };
    }
    throw new Error(`节点 E2EE 密钥文件已损坏: ${keyPath}`);
  }
  const kp = generateKeyPair();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ v: 1, ...kp }, null, 2) + "\n", { mode: 0o600 });
  return kp;
}
