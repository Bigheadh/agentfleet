/**
 * Pure, platform-independent E2EE helpers for the mobile app (no react-native /
 * expo imports, so they are directly unit-tested under vitest).
 */
import {
  decryptEvent,
  decryptTaskPayload,
  isValidPublicKey,
  NodeTrustPayload,
  type EventEnvelope,
  type KeyPair,
  type NodeInfo,
  type Project,
  type Task,
} from "@agentfleet/proto";

export interface TrustRecord {
  publicKey: string;
  verifiedVia: "qr" | "manual";
  pinnedAt: number;
}

export type TrustMap = Record<string, TrustRecord>;

export type NodeTrustStatus = "no-key" | "unverified" | "trusted" | "mismatch";

export function checkNodeTrust(node: Pick<NodeInfo, "id" | "publicKey">, trust: TrustMap): NodeTrustStatus {
  if (!node.publicKey) return "no-key";
  const pinned = trust[node.id];
  if (!pinned) return "unverified";
  return pinned.publicKey === node.publicKey ? "trusted" : "mismatch";
}

export function parseNodeTrustQr(raw: string): NodeTrustPayload | null {
  try {
    const parsed = NodeTrustPayload.safeParse(JSON.parse(raw));
    if (!parsed.success || !isValidPublicKey(parsed.data.publicKey)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export interface DecryptedTaskResult {
  task: Task;
  dek: Uint8Array | null;
  encrypted: boolean;
  locked: boolean;
  error?: string;
}

export function decryptTaskForDisplay(task: Task, deviceKey: KeyPair | null): DecryptedTaskResult {
  if (!task.e2ee) return { task, dek: null, encrypted: false, locked: false };
  if (!deviceKey) return { task, dek: null, encrypted: true, locked: true, error: "本设备尚未初始化加密密钥" };
  try {
    const dec = decryptTaskPayload(task.e2ee, deviceKey, task.project);
    return {
      task: { ...task, title: dec.title, prompt: dec.prompt },
      dek: dec.dek,
      encrypted: true,
      locked: false,
    };
  } catch (e) {
    return {
      task,
      dek: null,
      encrypted: true,
      locked: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function decryptEnvelope(env: EventEnvelope, dek: Uint8Array | null): EventEnvelope {
  if (env.event.type !== "encrypted") return env;
  if (!dek) {
    return { ...env, event: { type: "log", level: "warn", text: "无法解密端到端加密事件（本设备无此任务密钥）" } };
  }
  try {
    return { ...env, event: decryptEvent(dek, env.runId, env.seq, env.event) };
  } catch (e) {
    return {
      ...env,
      event: { type: "log", level: "error", text: `端到端事件解密校验失败：${e instanceof Error ? e.message : String(e)}` },
    };
  }
}

export function selectE2EERecipients(
  nodes: NodeInfo[],
  project: Project | null,
  trust: TrustMap,
  extraDeviceKeys: string[] = [],
): {
  recipientKeys: string[];
  trustedNodes: NodeInfo[];
  untrustedNodes: NodeInfo[];
  mismatchNodes: NodeInfo[];
} {
  const projectNodes = project ? nodes.filter((n) => project.nodes.includes(n.id)) : nodes;
  const trustedNodes: NodeInfo[] = [];
  const untrustedNodes: NodeInfo[] = [];
  const mismatchNodes: NodeInfo[] = [];
  for (const n of projectNodes) {
    const st = checkNodeTrust(n, trust);
    if (st === "trusted") trustedNodes.push(n);
    else if (st === "mismatch") mismatchNodes.push(n);
    else untrustedNodes.push(n);
  }
  const recipientKeys = [
    ...new Set([
      ...trustedNodes.map((n) => n.publicKey!).filter(Boolean),
      ...extraDeviceKeys.filter((k) => isValidPublicKey(k)),
    ]),
  ];
  return { recipientKeys, trustedNodes, untrustedNodes, mismatchNodes };
}
