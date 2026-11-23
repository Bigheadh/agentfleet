/**
 * End-to-end M1 loop on one machine, with real processes and sockets:
 *
 *   phone(API) -> hub -> fleetd -> git worktree -> agent (mock ACP / mock Codex app-server)
 *   approval round-trip, diff, follow-up turn, commit, discard, live WS stream.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, NodeInfo, Run, Task } from "../packages/proto/src/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NodeConfig } from "../packages/fleetd/src/config.ts";
import { type Daemon, startDaemon } from "../packages/fleetd/src/daemon.ts";
import { fixtureCommand, tempDir, tempRepo, waitFor } from "../packages/fleetd/test/helpers.ts";
import { startHub } from "../packages/hub/src/index.ts";

let hub: Awaited<ReturnType<typeof startHub>>;
let daemon: Daemon;
let base = "";
let token = "";
let repo = "";

async function api<T = any>(method: string, path: string, body?: unknown, auth = token): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

const getTask = (id: string) => api<{ task: Task; runs: Run[] }>("GET", `/api/tasks/${id}`);
const events = (runId: string) => api<EventEnvelope[]>("GET", `/api/runs/${runId}/events`);

/** waitFor with async predicate */
async function waitAsync<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const taskIn = (id: string, ...states: Task["state"][]) =>
  waitAsync(async () => {
    const d = await getTask(id);
    if (d.task.state === "failed") throw new Error(`task failed: ${d.task.note} ${d.runs[0]?.error}`);
    return states.includes(d.task.state) ? d : null;
  }, `task ${id} -> ${states.join("|")}`);

async function approveNext(runId: string, optionId: string, after = -1) {
  const env = await waitAsync(async () => {
    const evs = await events(runId);
    const resolved = new Set(evs.flatMap((e) => (e.event.type === "approval.resolved" ? [e.event.approvalId] : [])));
    return evs.find((e) => e.seq > after && e.event.type === "approval.requested" && !resolved.has(e.event.approvalId));
  }, "approval.requested");
  if (env.event.type !== "approval.requested") throw new Error("unreachable");
  await api("POST", `/api/runs/${runId}/approvals/${encodeURIComponent(env.event.approvalId)}`, { optionId });
  return env;
}

beforeAll(async () => {
  hub = await startHub({ dataDir: ":memory:", port: 0, host: "127.0.0.1", name: "e2e-hub" });
  base = `http://127.0.0.1:${hub.port}`;

  // Phone pairing (the QR flow, minus the camera).
  const code = hub.store.createPairingCode();
  const paired = await api<{ token: string; hubName: string }>("POST", "/api/pair", { code, deviceName: "test-phone" }, "");
  token = paired.token;
  expect(paired.hubName).toBe("e2e-hub");
  await expect(api("POST", "/api/pair", { code, deviceName: "again" }, "")).rejects.toThrow(/401/); // one-time code

  // Node join via a join token minted from the phone.
  const jt = await api<{ token: string }>("POST", "/api/nodes/join-token");
  const joined = await api<{ nodeId: string; nodeToken: string }>("POST", "/api/nodes/join", { joinToken: jt.token, name: "e2e-node" }, "");

  repo = tempRepo();
  const acp = fixtureCommand("mock-acp-agent");
  const codex = fixtureCommand("mock-codex-app-server");
  const cfg = NodeConfig.parse({
    hub: base,
    nodeId: joined.nodeId,
    token: joined.nodeToken,
    name: "e2e-node",
    workRoot: tempDir("agentfleet-wt-"),
    projects: { demo: { path: repo } },
    agents: {
      codex: { command: codex.command, args: codex.args, probeLogin: false },
      "acp:mock": { agent: "Mock ACP", command: acp.command, args: acp.args },
      "acp:gemini": { enabled: false },
      "acp:claude": { enabled: false },
      "acp:codex": { enabled: false },
    },
  });
  daemon = await startDaemon({ cfg, statePath: join(tempDir(), "runs.json"), log: () => {} });
});

afterAll(async () => {
  await daemon?.stop();
  await hub?.close();
});

describe("M1 loop", () => {
  it("registers the node with its agents and projects", async () => {
    const nodes = await waitAsync(async () => {
      const ns = await api<NodeInfo[]>("GET", "/api/nodes");
      return ns.length && ns[0]!.online ? ns : null;
    }, "node online");
    expect(nodes[0]!.projects).toEqual(["demo"]);
    expect(nodes[0]!.runtimes.map((r) => r.id).sort()).toEqual(["acp:mock", "codex"]);
    expect(await api("GET", "/api/projects")).toEqual([{ id: "demo", nodes: [nodes[0]!.id] }]);
  });

  it("rejects unauthenticated clients", async () => {
    await expect(api("GET", "/api/tasks", undefined, "bogus")).rejects.toThrow(/401/);
  });

  it("ACP agent: dispatch -> approve -> diff -> follow-up -> commit", async () => {
    const task = await api<Task>("POST", "/api/tasks", { project: "demo", prompt: "写一个 hello.txt", constraints: { agent: "acp:mock" } });

    // Live stream over the client WebSocket, as the phone would see it.
    const live: EventEnvelope[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/client?token=${token}`);
    await new Promise((r) => ws.once("open", r));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "event") live.push(m.envelope);
    });

    const waiting = await taskIn(task.id, "waiting_approval");
    const runId = waiting.task.runId!;
    ws.send(JSON.stringify({ type: "subscribe", runId, after: -1 }));
    expect(waiting.runs[0]).toMatchObject({ runtimeId: "acp:mock", status: "waiting_approval", pendingApprovals: 1 });
    expect(waiting.runs[0]!.branch).toMatch(/^fleet\//);

    const req = await approveNext(runId, "allow");
    expect(req.event).toMatchObject({ risk: "write", title: "写入 hello.txt" });

    const review = await taskIn(task.id, "review");
    expect(review.runs[0]).toMatchObject({ status: "completed", pendingApprovals: 0 });
    const wt = review.runs[0]!.worktree!;
    expect(readFileSync(join(wt, "hello.txt"), "utf8")).toContain("turn 1");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false); // main checkout untouched

    const evs = await events(runId);
    const diff = evs.findLast((e) => e.event.type === "diff.updated")!.event;
    expect(diff).toMatchObject({ files: 1, additions: 1 });
    if (diff.type === "diff.updated") expect(diff.unified).toContain("hello.txt");
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i)); // gap-free, ordered
    expect(evs.find((e) => e.event.type === "approval.resolved")!.event).toMatchObject({ by: "user", optionId: "allow" });

    await waitFor(() => live.some((e) => e.event.type === "diff.updated"), 5000, "live diff event");
    ws.close();

    // Follow-up prompt re-opens the run in the same worktree / agent session.
    const lastSeq = evs.at(-1)!.seq;
    await api("POST", `/api/runs/${runId}/input`, { text: "再改一次" });
    await approveNext(runId, "allow", lastSeq);
    await waitAsync(async () => {
      const d = await getTask(task.id);
      return d.task.state === "review" && readFileSync(join(wt, "hello.txt"), "utf8").includes("turn 2");
    }, "follow-up turn");

    const commit = await api<{ ok: boolean; output: string }>("POST", `/api/runs/${runId}/actions`, { action: "commit" });
    expect(commit.ok).toBe(true);
    const log = execFileSync("git", ["-C", repo, "log", "--oneline", review.runs[0]!.branch!]).toString();
    expect(log).toContain("agentfleet: 写一个 hello.txt");
  });

  it("Codex native adapter: dispatch -> approve exec -> review -> discard", async () => {
    const task = await api<Task>("POST", "/api/tasks", { project: "demo", prompt: "生成 codex.txt", constraints: { agent: "codex" } });
    const waiting = await taskIn(task.id, "waiting_approval");
    const runId = waiting.task.runId!;
    const req = await approveNext(runId, "accept");
    expect(req.event).toMatchObject({ risk: "exec", command: "sh -c 'echo codex > codex.txt'" });

    const review = await taskIn(task.id, "review");
    const wt = review.runs[0]!.worktree!;
    expect(existsSync(join(wt, "codex.txt"))).toBe(true);
    const evs = await events(runId);
    expect(evs.some((e) => e.event.type === "usage.updated")).toBe(true);
    expect(evs.some((e) => e.event.type === "tool.updated" && e.event.exitCode === 0)).toBe(true);

    const res = await api<{ ok: boolean }>("POST", `/api/runs/${runId}/actions`, { action: "discard" });
    expect(res.ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect((await getTask(task.id)).task.state).toBe("cancelled");
  });

  it("interrupt cancels a running task", async () => {
    const task = await api<Task>("POST", "/api/tasks", { project: "demo", prompt: "slow job", constraints: { agent: "acp:mock" } });
    const running = await taskIn(task.id, "running");
    const runId = running.task.runId!;
    await waitAsync(async () => (await events(runId)).some((e) => e.event.type === "message.delta" && e.event.role === "agent"), "agent output");
    await api("POST", `/api/runs/${runId}/interrupt`);
    const done = await taskIn(task.id, "cancelled");
    await waitAsync(async () => (await getTask(task.id)).runs[0]!.status === "interrupted", "run interrupted");
    expect(done.task.state).toBe("cancelled");
  });

  it("explains why a task cannot be scheduled", async () => {
    const task = await api<Task>("POST", "/api/tasks", { project: "demo", prompt: "x", constraints: { agent: "acp:claude" } });
    const d = await getTask(task.id);
    expect(d.task.state).toBe("queued");
    expect(d.task.note).toContain("acp:claude");
    await api("POST", `/api/tasks/${task.id}/cancel`);
  });
});
