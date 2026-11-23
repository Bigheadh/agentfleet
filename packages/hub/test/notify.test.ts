import { PROTOCOL_VERSION, type HubToNode } from "@agentfleet/proto";
import { afterEach, describe, expect, it } from "vitest";
import { buildNotification, startHub } from "../src/index.ts";

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** Fake fetch: records calls; Expo answers with one ticket per message (token "...[dead]" -> DeviceNotRegistered). */
function fakeFetch(calls: Call[], opts: { fail?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    if (opts.fail && url.startsWith(opts.fail)) return new Response("boom", { status: 500 });
    if (url.includes("exp.host")) {
      const data = (body as { to: string }[]).map((m) =>
        m.to.includes("dead") ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "x" },
      );
      return Response.json({ data });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(notify: Parameters<typeof startHub>[0]["notify"], calls: Call[], fetchOpts?: { fail?: string }) {
  const h = await startHub({ dataDir: ":memory:", port: 0, host: "127.0.0.1", name: "t", notify, notifyFetch: fakeFetch(calls, fetchOpts) });
  closers.push(h.close);
  const base = `http://127.0.0.1:${h.port}`;
  const pair = async () => {
    const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: h.store.createPairingCode(), deviceName: "p" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  // Fake node attached straight to the Hub core (transport is covered by the e2e test).
  const toNode: HubToNode[] = [];
  const nodeId = "node-1";
  h.hub.nodeConnected(nodeId, { send: (m) => toNode.push(m), close: () => {} });
  h.hub.nodeMessage(nodeId, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    activeRuns: [],
    node: {
      id: nodeId,
      name: "vm",
      os: "linux",
      labels: [],
      maxConcurrency: 2,
      projects: ["web"],
      runtimes: [{ id: "codex", agent: "Codex", tier: "native", version: "1", installed: true, loggedIn: true, models: [], supports: [] }],
    },
  });
  return { h, pair, api, toNode, nodeId };
}

describe("push notifications", () => {
  it("registers tokens via the API and reports status in /api/me", async () => {
    const calls: Call[] = [];
    const { pair, api } = await setup({ ntfyUrl: "https://ntfy.example/topic-1" }, calls);
    const token = await pair();
    expect((await api(token, "GET", "/api/me")).json.push).toEqual({ expoEnabled: true, registered: false, channels: ["ntfy"] });
    expect((await api(token, "POST", "/api/devices/me/push", { expoPushToken: "not-a-token" })).status).toBe(400);
    expect((await api(token, "POST", "/api/devices/me/push", { expoPushToken: "ExponentPushToken[abc]" })).status).toBe(200);
    expect((await api(token, "GET", "/api/me")).json.push.registered).toBe(true);
    await api(token, "POST", "/api/devices/me/push", { expoPushToken: null });
    expect((await api(token, "GET", "/api/me")).json.push.registered).toBe(false);
  });

  it("refuses Expo registration when the hub disabled Expo push", async () => {
    const { pair, api } = await setup({ expo: false }, []);
    const token = await pair();
    expect((await api(token, "POST", "/api/devices/me/push", { expoPushToken: "ExponentPushToken[abc]" })).status).toBe(409);
  });

  it("notifies on approval requests and review, over every channel, and drops dead tokens", async () => {
    const calls: Call[] = [];
    const { h, pair, api, toNode, nodeId } = await setup({ ntfyUrl: "https://ntfy.example/sub/topic-1", ntfyToken: "tk", webhookUrl: "https://hook.example/x" }, calls);
    const live = await pair();
    const dead = await pair();
    await api(live, "POST", "/api/devices/me/push", { expoPushToken: "ExponentPushToken[live]" });
    await api(dead, "POST", "/api/devices/me/push", { expoPushToken: "ExponentPushToken[dead]" });

    const task = (await api(live, "POST", "/api/tasks", { project: "web", prompt: "Fix the login bug\nmore details" })).json;
    const assign = toNode.find((m) => m.type === "run.assign");
    expect(assign).toBeDefined();
    const runId = assign!.type === "run.assign" ? assign!.spec.runId : "";
    h.hub.nodeMessage(nodeId, { type: "run.started", runId, branch: "fleet/x", worktree: "/tmp/x" });
    h.hub.nodeMessage(nodeId, {
      type: "run.event",
      runId,
      seq: 0,
      ts: Date.now(),
      event: { type: "approval.requested", approvalId: "a1", title: "rm -rf build", risk: "exec", options: [{ id: "y", label: "允许", kind: "allow_once" }] },
    });
    await h.notifier!.flush();

    const expo = calls.filter((c) => c.url.includes("exp.host"));
    expect(expo).toHaveLength(1);
    expect(expo[0]!.body).toHaveLength(2);
    expect(expo[0]!.body[0]).toMatchObject({
      title: "需要审批 · web",
      body: "Fix the login bug\n[exec] rm -rf build",
      data: { kind: "approval", taskId: task.id, runId },
      priority: "high",
      sound: "default",
      channelId: "agentfleet",
    });
    expect(h.store.pushTargets().map((t) => t.token)).toEqual(["ExponentPushToken[live]"]);

    const ntfy = calls.find((c) => c.url.startsWith("https://ntfy.example"))!;
    expect(ntfy.url).toBe("https://ntfy.example/sub");
    expect(ntfy.body).toMatchObject({ topic: "topic-1", title: "需要审批 · web", priority: 4, click: `agentfleet://tasks/${task.id}` });
    expect(ntfy.headers.authorization).toBe("Bearer tk");
    expect(calls.find((c) => c.url === "https://hook.example/x")!.body).toMatchObject({ source: "agentfleet", kind: "approval" });

    calls.length = 0;
    h.hub.nodeMessage(nodeId, { type: "run.event", runId, seq: 1, ts: Date.now(), event: { type: "approval.resolved", approvalId: "a1", optionId: "y", by: "user" } });
    h.hub.nodeMessage(nodeId, { type: "run.ended", runId, status: "completed", error: null });
    await h.notifier!.flush();
    const review = calls.filter((c) => c.url.includes("exp.host"));
    expect(review).toHaveLength(1);
    expect(review[0]!.body).toEqual([expect.objectContaining({ to: "ExponentPushToken[live]", title: "任务待审阅 · web", priority: "default" })]);
  });

  it("does not notify when a failed run is requeued, only on final failure", async () => {
    const calls: Call[] = [];
    const { h, pair, api, toNode, nodeId } = await setup({ webhookUrl: "https://hook.example/x" }, calls);
    const token = await pair();
    await api(token, "POST", "/api/tasks", { project: "web", prompt: "p" });
    const runId = () => toNode.filter((m) => m.type === "run.assign").map((m) => (m.type === "run.assign" ? m.spec.runId : "")).at(-1)!;
    h.hub.nodeMessage(nodeId, { type: "run.ended", runId: runId(), status: "failed", error: "agent crashed" });
    await h.notifier!.flush();
    expect(calls.map((c) => c.body.kind)).toEqual(["failed"]); // run.ended from the node is final (requeue only on node loss)
    expect(calls[0]!.body.body).toBe("p\nagent crashed");
  });

  it("survives a failing channel", async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const { h, pair, api, toNode, nodeId } = await setup({ webhookUrl: "https://hook.example/x", ntfyUrl: "https://ntfy.example/t" }, calls, { fail: "https://hook.example" });
    (h.notifier as any).log = (m: string) => logs.push(m);
    const token = await pair();
    await api(token, "POST", "/api/tasks", { project: "web", prompt: "p" });
    const assign = toNode.find((m) => m.type === "run.assign")!;
    h.hub.nodeMessage(nodeId, { type: "run.ended", runId: assign.type === "run.assign" ? assign.spec.runId : "", status: "completed", error: null });
    await h.notifier!.flush();
    expect(calls).toHaveLength(2);
    expect(logs.join("\n")).toContain("HTTP 500");
    expect((await api(token, "GET", "/api/tasks")).json[0].state).toBe("review");
  });
});

describe("buildNotification", () => {
  it("redacts task content", () => {
    const n = buildNotification({ kind: "approval", project: "web", taskTitle: "secret plan", taskId: "t", runId: "r", approvalTitle: "cat ~/.ssh/id_rsa", risk: "exec" }, true);
    expect(n.body).not.toContain("secret");
    expect(n.body).not.toContain("ssh");
    expect(n.title).toBe("需要审批 · web");
  });
  it("clips long bodies", () => {
    const n = buildNotification({ kind: "review", project: "web", taskTitle: "x".repeat(1000), taskId: "t" }, false);
    expect(n.body.length).toBe(240);
    expect(n.data).toEqual({ kind: "review", taskId: "t" });
  });
});
