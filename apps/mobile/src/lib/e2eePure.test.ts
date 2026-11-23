import {
  ENCRYPTED_PLACEHOLDER,
  ENCRYPTED_TASK_TITLE,
  encryptEvent,
  encryptTaskPayload,
  generateKeyPair,
  type EventEnvelope,
  type NodeInfo,
  type Task,
} from "@agentfleet/proto";
import { describe, expect, it } from "vitest";
import {
  checkNodeTrust,
  decryptEnvelope,
  decryptTaskForDisplay,
  parseNodeTrustQr,
  selectE2EERecipients,
  type TrustMap,
} from "./e2eePure";

function makeNode(id: string, publicKey?: string): NodeInfo {
  return {
    id,
    name: id,
    os: "linux",
    labels: [],
    maxConcurrency: 2,
    running: 0,
    online: true,
    lastSeen: 0,
    runtimes: [],
    projects: ["web"],
    publicKey,
  };
}

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project: "web",
    title: "plain",
    prompt: "plain prompt",
    priority: "normal",
    constraints: { agent: "any", requires: [], labels: [] },
    state: "queued",
    createdAt: 1,
    updatedAt: 1,
    runId: null,
    attempts: 0,
    ...partial,
  };
}

describe("mobile e2eePure", () => {
  it("tracks node trust and flags key mismatches (MITM)", () => {
    const k1 = generateKeyPair();
    const k2 = generateKeyPair();
    const trust: TrustMap = { n1: { publicKey: k1.publicKey, verifiedVia: "qr", pinnedAt: 1 } };
    expect(checkNodeTrust(makeNode("n0"), trust)).toBe("no-key");
    expect(checkNodeTrust(makeNode("n1", k1.publicKey), trust)).toBe("trusted");
    expect(checkNodeTrust(makeNode("n1", k2.publicKey), trust)).toBe("mismatch");
    expect(checkNodeTrust(makeNode("n2", k2.publicKey), trust)).toBe("unverified");
  });

  it("parses valid node trust QR payloads and rejects garbage", () => {
    const k = generateKeyPair();
    const ok = parseNodeTrustQr(JSON.stringify({ v: 1, type: "node-key", nodeId: "n1", name: "mac", publicKey: k.publicKey }));
    expect(ok).toEqual({ v: 1, type: "node-key", nodeId: "n1", name: "mac", publicKey: k.publicKey });
    expect(parseNodeTrustQr("not json")).toBeNull();
    expect(parseNodeTrustQr(JSON.stringify({ v: 1, type: "node-key", nodeId: "n1", name: "mac", publicKey: "bad" }))).toBeNull();
  });

  it("decrypts tasks and events with the device key and handles locked/tampered gracefully", () => {
    const phone = generateKeyPair();
    const other = generateKeyPair();
    const node = generateKeyPair();
    const { e2ee, dek } = encryptTaskPayload({ title: "秘密标题", prompt: "秘密提示词" }, phone, [node.publicKey], "web");
    const encTask = makeTask({ title: ENCRYPTED_TASK_TITLE, prompt: ENCRYPTED_PLACEHOLDER, e2ee });

    const ok = decryptTaskForDisplay(encTask, phone);
    expect(ok.encrypted).toBe(true);
    expect(ok.locked).toBe(false);
    expect(ok.task.title).toBe("秘密标题");
    expect(ok.task.prompt).toBe("秘密提示词");

    const locked = decryptTaskForDisplay(encTask, other);
    expect(locked.locked).toBe(true);
    expect(locked.dek).toBeNull();

    const encEnv: EventEnvelope = {
      runId: "r1",
      seq: 3,
      ts: 100,
      event: encryptEvent(dek, "r1", 3, { type: "message.delta", role: "agent", text: "你好" }),
    };
    expect(decryptEnvelope(encEnv, ok.dek).event).toEqual({ type: "message.delta", role: "agent", text: "你好" });
    // Wrong seq -> error log, never throws in UI.
    expect(decryptEnvelope({ ...encEnv, seq: 4 }, ok.dek).event.type).toBe("log");
    expect(decryptEnvelope(encEnv, null).event.type).toBe("log");
  });

  it("selects only trusted nodes for the chosen project", () => {
    const k1 = generateKeyPair();
    const k2 = generateKeyPair();
    const k3 = generateKeyPair();
    const dev2 = generateKeyPair();
    const nodes = [makeNode("n1", k1.publicKey), makeNode("n2", k2.publicKey), makeNode("n3", k3.publicKey)];
    const trust: TrustMap = {
      n1: { publicKey: k1.publicKey, verifiedVia: "qr", pinnedAt: 1 },
      n2: { publicKey: k3.publicKey, verifiedVia: "manual", pinnedAt: 1 }, // mismatch!
    };
    const sel = selectE2EERecipients(nodes, { id: "web", nodes: ["n1", "n2", "n3"] }, trust, [dev2.publicKey]);
    expect(sel.trustedNodes.map((n) => n.id)).toEqual(["n1"]);
    expect(sel.mismatchNodes.map((n) => n.id)).toEqual(["n2"]);
    expect(sel.untrustedNodes.map((n) => n.id)).toEqual(["n3"]);
    expect(sel.recipientKeys).toEqual([k1.publicKey, dev2.publicKey]);
  });
});
