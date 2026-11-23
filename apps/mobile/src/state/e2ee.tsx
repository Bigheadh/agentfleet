/**
 * Mobile E2EE state:
 *  - Persistent per-device X25519 identity keypair in SecureStore / localStorage
 *  - Wires expo-crypto as the RNG provider for @agentfleet/proto
 *  - Persists pinned node public keys (TrustMap) + default E2EE toggle
 *  - Auto-registers this device's public key with the hub and tracks other paired devices
 */
import {
  generateKeyPair,
  isValidPublicKey,
  keyFingerprint,
  setRandomBytesProvider,
  type KeyPair,
  type NodeInfo,
  type Task,
} from "@agentfleet/proto";
import * as Crypto from "expo-crypto";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { HubClient } from "../api/client";
import { checkNodeTrust, decryptTaskForDisplay, type DecryptedTaskResult, type NodeTrustStatus, type TrustMap } from "../lib/e2eePure";
import * as storage from "./storage";

// Ensure crypto randomness works identically on iOS/Android Hermes and Web.
setRandomBytesProvider((n) => Crypto.getRandomBytes(n));

const KEYPAIR_STORAGE = "agentfleet.e2ee.keypair.v1";
const TRUST_STORAGE = "agentfleet.e2ee.trustedNodes.v1";
const ENABLED_STORAGE = "agentfleet.e2ee.enabled.v1";

/** Load (or generate & persist) this device's long-term X25519 identity keypair. */
export async function loadOrCreateDeviceKeyPair(): Promise<KeyPair> {
  try {
    const raw = await storage.getItem(KEYPAIR_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<KeyPair>;
      if (typeof parsed.privateKey === "string" && typeof parsed.publicKey === "string" && isValidPublicKey(parsed.publicKey)) {
        return { privateKey: parsed.privateKey, publicKey: parsed.publicKey };
      }
    }
  } catch {
    // Regenerate below if corrupted.
  }
  const kp = generateKeyPair();
  await storage.setItem(KEYPAIR_STORAGE, JSON.stringify(kp));
  return kp;
}

interface E2EEContextValue {
  ready: boolean;
  keyPair: KeyPair | null;
  fingerprint: string | null;
  /** Default E2EE toggle for new tasks. */
  enabled: boolean;
  setEnabled: (v: boolean) => Promise<void>;
  /** Pinned node public keys (nodeId -> TrustRecord). */
  trustedNodes: TrustMap;
  trustNode: (nodeId: string, publicKey: string, via: "qr" | "manual") => Promise<void>;
  untrustNode: (nodeId: string) => Promise<void>;
  trustStatus: (node: Pick<NodeInfo, "id" | "publicKey">) => NodeTrustStatus;
  /** Public keys of all paired devices on this hub (multi-device read access). */
  devicePublicKeys: string[];
  decryptTask: (task: Task) => DecryptedTaskResult;
}

const E2EEContext = createContext<E2EEContextValue | null>(null);

export function E2EEProvider({ client, children }: { client: HubClient; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [keyPair, setKeyPair] = useState<KeyPair | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const [trustedNodes, setTrustedNodes] = useState<TrustMap>({});
  const [devicePublicKeys, setDevicePublicKeys] = useState<string[]>([]);
  const dekCache = useRef(new Map<string, DecryptedTaskResult>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [kp, rawTrust, rawEnabled] = await Promise.all([
        loadOrCreateDeviceKeyPair(),
        storage.getItem(TRUST_STORAGE).catch(() => null),
        storage.getItem(ENABLED_STORAGE).catch(() => null),
      ]);
      if (cancelled) return;
      setKeyPair(kp);
      if (rawEnabled !== null) setEnabledState(rawEnabled !== "0");
      if (rawTrust) {
        try {
          setTrustedNodes(JSON.parse(rawTrust) as TrustMap);
        } catch {
          setTrustedNodes({});
        }
      }
      setReady(true);

      // Ensure our public key is registered on the hub and learn any other paired devices.
      try {
        const me = await client.me();
        if (cancelled) return;
        if (me.e2ee?.publicKey !== kp.publicKey) {
          await client.registerKey(kp.publicKey);
        }
        const keys = me.e2ee?.devicePublicKeys ?? [];
        setDevicePublicKeys(keys.includes(kp.publicKey) ? keys : [...keys, kp.publicKey]);
      } catch {
        if (!cancelled) setDevicePublicKeys([kp.publicKey]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const setEnabled = useCallback(async (v: boolean) => {
    setEnabledState(v);
    await storage.setItem(ENABLED_STORAGE, v ? "1" : "0").catch(() => {});
  }, []);

  const trustNode = useCallback(async (nodeId: string, publicKey: string, via: "qr" | "manual") => {
    if (!isValidPublicKey(publicKey)) return;
    setTrustedNodes((prev) => {
      const next: TrustMap = { ...prev, [nodeId]: { publicKey, verifiedVia: via, pinnedAt: Date.now() } };
      void storage.setItem(TRUST_STORAGE, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const untrustNode = useCallback(async (nodeId: string) => {
    setTrustedNodes((prev) => {
      const { [nodeId]: _drop, ...rest } = prev;
      void storage.setItem(TRUST_STORAGE, JSON.stringify(rest)).catch(() => {});
      return rest;
    });
  }, []);

  const trustStatus = useCallback(
    (node: Pick<NodeInfo, "id" | "publicKey">) => checkNodeTrust(node, trustedNodes),
    [trustedNodes],
  );

  const decryptTask = useCallback(
    (task: Task): DecryptedTaskResult => {
      if (!task.e2ee) return { task, dek: null, encrypted: false, locked: false };
      const cacheKey = `${task.id}:${task.e2ee.box.n}:${keyPair?.publicKey ?? ""}`;
      const hit = dekCache.current.get(cacheKey);
      if (hit) {
        // Keep latest live metadata (state, note, runId, updatedAt) while reusing decrypted title/prompt/dek.
        return hit.locked
          ? { ...hit, task }
          : { ...hit, task: { ...task, title: hit.task.title, prompt: hit.task.prompt } };
      }
      const res = decryptTaskForDisplay(task, keyPair);
      if (keyPair) dekCache.current.set(cacheKey, res);
      return res;
    },
    [keyPair],
  );

  const fingerprint = useMemo(() => (keyPair ? keyFingerprint(keyPair.publicKey) : null), [keyPair]);

  const value = useMemo<E2EEContextValue>(
    () => ({
      ready,
      keyPair,
      fingerprint,
      enabled,
      setEnabled,
      trustedNodes,
      trustNode,
      untrustNode,
      trustStatus,
      devicePublicKeys,
      decryptTask,
    }),
    [ready, keyPair, fingerprint, enabled, setEnabled, trustedNodes, trustNode, untrustNode, trustStatus, devicePublicKeys, decryptTask],
  );

  return <E2EEContext.Provider value={value}>{children}</E2EEContext.Provider>;
}

export function useE2EE(): E2EEContextValue {
  const ctx = useContext(E2EEContext);
  if (!ctx) throw new Error("useE2EE must be used inside <E2EEProvider>");
  return ctx;
}
