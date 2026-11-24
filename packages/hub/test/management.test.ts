import { generateKeyPair, PROTOCOL_VERSION, type AuditEntry, type DeviceInfo, type Task } from "@agentfleet/proto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/index.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup() {
  const h = await startHub({ dataDir: ":memory:", port: 0, host: "127.0.0.1", name: "mgmt-hub", notify: false });
  closers.push(h.close);
  const base = `http://127.0.0.1:${h.port}`;
  const pair = async (deviceName: string, publicKey?: string) => {
    const r = await fetch(`${base}/api/pair`, {
      method: "POST",
      body: JSON.stringify({ code: h.store.createPairingCode(), deviceName, ...(publicKey ? { publicKey } : {}) }),
    });
    return (await r.json()) as { token: string; deviceId: string };
  };
  const api = async <T = any>(token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as T };
  };
  return { h, base, pair, api };
}

describe("hub device, node, and audit management", () => {
  it("lists paired devices, updates lastSeen, and kicks live WebSockets on revoke", async () => {
    const { base, pair, api } = await setup();
    const k1 = generateKeyPair();
    const d1 = await pair("iPhone", k1.publicKey);
    const d2 = await pair("Old iPad");

    // Open a live WS from d2.
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/client?token=${d2.token}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    const list1 = await api<DeviceInfo[]>(d1.token, "GET", "/api/devices");
    expect(list1.status).toBe(200);
    expect(list1.json).toHaveLength(2);
    const me = list1.json.find((d) => d.id === d1.deviceId)!;
    const other = list1.json.find((d) => d.id === d2.deviceId)!;
    expect(me.current).toBe(true);
    expect(me.publicKey).toBe(k1.publicKey);
    expect(me.lastSeen).not.toBeNull();
    expect(other.current).toBe(false);
    expect(other.lastSeen).not.toBeNull();

    // Revoke d2 -> WS closes immediately with 4001 and REST calls fail with 401.
    expect((await api(d1.token, "POST", `/api/devices/${d2.deviceId}/revoke`)).status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await api(d2.token, "GET", "/api/me")).status).toBe(401);

    const list2 = await api<DeviceInfo[]>(d1.token, "GET", "/api/devices");
    expect(list2.json.map((d) => d.id)).toEqual([d1.deviceId]);

    // Audit log recorded pair + revoke.
    const audit = await api<AuditEntry[]>(d1.token, "GET", "/api/audit?limit=10");
    expect(audit.status).toBe(200);
    expect(audit.json.some((a) => a.action === "device.revoke" && a.detail === d2.deviceId)).toBe(true);
  });

  it("refuses removing an online node and removes an offline node cleanly", async () => {
    const { h, pair, api } = await setup();
    const d1 = await pair("Phone");
    const joined = h.store.joinNode(h.store.createJoinToken(), "mac")!;
    const conn = { send: () => {}, close: () => {} };
    h.hub.nodeConnected(joined.nodeId, conn);
    h.hub.nodeMessage(joined.nodeId, {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      activeRuns: [],
      node: { id: joined.nodeId, name: "mac", os: "darwin", labels: [], maxConcurrency: 2, runtimes: [], projects: ["web"] },
    });

    // Online -> 409
    expect((await api(d1.token, "POST", `/api/nodes/${joined.nodeId}/remove`)).status).toBe(409);

    // Offline -> 200 and gone from /api/nodes
    h.hub.nodeDisconnected(joined.nodeId, conn);
    expect((await api(d1.token, "POST", `/api/nodes/${joined.nodeId}/remove`)).status).toBe(200);
    expect((await api(d1.token, "GET", "/api/nodes")).json).toEqual([]);
  });

  it("preserves groupId for parallel multi-agent tasks", async () => {
    const { pair, api } = await setup();
    const d1 = await pair("Phone");
    const t1 = await api<Task>(d1.token, "POST", "/api/tasks", {
      project: "web",
      prompt: "fix bug",
      constraints: { agent: "codex" },
      groupId: "batch-42",
    });
    expect(t1.status).toBe(200);
    expect(t1.json.groupId).toBe("batch-42");
  });
});
