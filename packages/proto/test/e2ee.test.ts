import { describe, expect, it } from "vitest";
import {
  decryptApproval,
  decryptEvent,
  decryptInput,
  decryptTaskPayload,
  encryptApproval,
  encryptEvent,
  encryptInput,
  encryptTaskPayload,
  fromBase64,
  generateKeyPair,
  isValidPublicKey,
  keyFingerprint,
  keyId,
  toBase64,
} from "../src/index.ts";

describe("e2ee primitives", () => {
  it("base64 roundtrips arbitrary byte lengths", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33, 255]) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = (i * 37) & 255;
      expect(fromBase64(toBase64(buf))).toEqual(buf);
    }
  });

  it("validates public keys and produces stable fingerprints", () => {
    const kp = generateKeyPair();
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    expect(isValidPublicKey("not-a-key")).toBe(false);
    expect(keyId(kp.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint(kp.publicKey)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("encrypts a task for multiple nodes + sender, and blocks unauthorized/tampered/forged attempts", () => {
    const phone = generateKeyPair();
    const nodeA = generateKeyPair();
    const nodeB = generateKeyPair();
    const eve = generateKeyPair();

    const { e2ee, dek } = encryptTaskPayload(
      { title: "修复认证漏洞", prompt: "检查 src/auth.ts 的 JWT 校验并补单元测试" },
      phone,
      [nodeA.publicKey, nodeB.publicKey],
      "web",
    );
    expect(e2ee.keys).toHaveLength(3); // phone + nodeA + nodeB

    // Sender and both target nodes recover the exact same DEK and plaintext.
    for (const kp of [phone, nodeA, nodeB]) {
      const dec = decryptTaskPayload(e2ee, kp, "web");
      expect(dec.title).toBe("修复认证漏洞");
      expect(dec.prompt).toContain("JWT");
      expect(dec.senderPublicKey).toBe(phone.publicKey);
      expect(dec.dek).toEqual(dek);
    }

    // Unlisted node cannot decrypt.
    expect(() => decryptTaskPayload(e2ee, eve, "web")).toThrow();

    // Wrong project AAD fails.
    expect(() => decryptTaskPayload(e2ee, nodeA, "other-project")).toThrow();

    // Forged sender key fails authenticated key unwrap (ss DH mismatch).
    expect(() => decryptTaskPayload({ ...e2ee, spk: eve.publicKey }, nodeA, "web")).toThrow();

    // Tampered ciphertext fails Poly1305 tag.
    const badBytes = fromBase64(e2ee.box.c);
    badBytes[0]! ^= 0xff;
    expect(() => decryptTaskPayload({ ...e2ee, box: { ...e2ee.box, c: toBase64(badBytes) } }, nodeA, "web")).toThrow();
  });

  it("encrypts events with routing hints and binds (runId, seq) in AAD", () => {
    const phone = generateKeyPair();
    const node = generateKeyPair();
    const { dek } = encryptTaskPayload({ title: "t", prompt: "p" }, phone, [node.publicKey], "web");

    const appr = encryptEvent(dek, "run-1", 5, {
      type: "approval.requested",
      approvalId: "a1",
      title: "rm -rf dist",
      risk: "exec",
      options: [{ id: "allow", label: "允许", kind: "allow_once" }],
    });
    expect(appr.type).toBe("encrypted");
    expect(appr.hint).toBe("approval.requested");
    expect(JSON.stringify(appr)).not.toContain("rm -rf");

    const plain = decryptEvent(dek, "run-1", 5, appr);
    expect(plain).toMatchObject({ type: "approval.requested", approvalId: "a1", title: "rm -rf dist" });

    // Reordering seq or splicing into another run fails.
    expect(() => decryptEvent(dek, "run-1", 6, appr)).toThrow();
    expect(() => decryptEvent(dek, "run-2", 5, appr)).toThrow();

    const st = encryptEvent(dek, "run-1", 6, { type: "run.status", status: "running", detail: "secret branch" });
    expect(st.hint).toBe("run.status");
    expect(st.status).toBe("running");
    expect(JSON.stringify(st)).not.toContain("secret branch");
  });

  it("encrypts inputs and approvals and prevents approvalId substitution", () => {
    const phone = generateKeyPair();
    const node = generateKeyPair();
    const { dek } = encryptTaskPayload({ title: "t", prompt: "p" }, phone, [node.publicKey], "web");

    const inpBox = encryptInput(dek, "run-1", "再补一个边界用例");
    expect(JSON.stringify(inpBox)).not.toContain("边界");
    const inp = decryptInput(dek, "run-1", inpBox);
    expect(inp.text).toBe("再补一个边界用例");
    expect(inp.msgId.length).toBeGreaterThan(8);
    expect(() => decryptInput(dek, "run-2", inpBox)).toThrow();

    const apprBox = encryptApproval(dek, "run-1", "appr-1", "allow_once");
    expect(decryptApproval(dek, "run-1", "appr-1", apprBox)).toBe("allow_once");
    // Hub cannot replay approval for a different approvalId or runId.
    expect(() => decryptApproval(dek, "run-1", "appr-2", apprBox)).toThrow();
    expect(() => decryptApproval(dek, "run-2", "appr-1", apprBox)).toThrow();
  });
});
