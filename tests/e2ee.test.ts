/**
 * End-to-end E2EE tests: real hub + real fleetd + mock ACP agent.
 * Proves the hub never sees prompts, titles, follow-ups, approvals, outputs,
 * or diffs — while scheduling, approvals, push notifications, and git commits
 * all continue to work.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptEvent,
  decryptTaskPayload,
  ENCRYPTED_PLACEHOLDER,
  ENCRYPTED_TASK_TITLE,
  encryptApproval,
  encryptInput,
  encryptTaskPayload,
  generateKeyPair,
  type EventEnvelope,
  type MeResponse,
  type NodeInfo,
  type Run,
  type Task,
} from "../packages/proto/src/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeConfig } from "../packages/fleetd/src/config.ts";
import { type Daemon, startDaemon } from "../packages/fleetd/src/daemon.ts";
import { fixtureCommand, tempDir, tempRepo } from "../packages/fleetd/test/helpers.ts";
import { startHub } from "../packages/hub/src/index.ts";

let hub: Awaited<ReturnType<typeof startHub>>;
let daemon: Daemon;
let base = "";
let token = "";
let repo = "";
const phoneKey = generateKeyPair();
const pushCalls: { url: string; body: any }[] = [];

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

async function waitAsync<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  hub = await startHub({
    dataDir: ":memory:",
    port: 0,
    host: "127.0.0.1",
    name: "e2ee-hub",
    notify: { expo: false, webhookUrl: "https://hook.example/e2ee" },
    notifyFetch: (async (url: string | URL | Request, init?: RequestInit) => {
      pushCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  base = `http://127.0.0.1:${hub.port}`;

  const code = hub.store.createPairingCode();
  const paired = await api<{ token: string }>("POST", "/api/pair", { code, deviceName: "e2ee-phone", publicKey: phoneKey.publicKey }, "");
  token = paired.token;

  const jt = await api<{ token: string }>("POST", "/api/nodes/join-token");
  const joined = await api<{ nodeId: string; nodeToken: string }>("POST", "/api/nodes/join", { joinToken: jt.token, name: "e2ee-node" }, "");

  repo = tempRepo();
  const acp = fixtureCommand("mock-acp-agent");
  const cfg = NodeConfig.parse({
    hub: base,
    nodeId: joined.nodeId,
    token: joined.nodeToken,
    name: "e2ee-node",
    workRoot: tempDir("agentfleet-e2ee-wt-"),
    projects: { demo: { path: repo } },
    e2ee: { mode: "required", trustedDevices: [phoneKey.publicKey] },
    agents: {
      codex: { enabled: false },
      "acp:mock": { agent: "Mock ACP", command: acp.command, args: acp.args },
      "acp:gemini": { enabled: false },
      "acp:claude": { enabled: false },
      "acp:codex": { enabled: false },
    },
  });
  daemon = await startDaemon({
    cfg,
    statePath: join(tempDir(), "runs.json"),
    identityPath: join(tempDir(), "identity.key"),
    log: () => {},
  });
});

afterAll(async () => {
  await daemon?.stop();
  await hub?.close();
});

describe("E2EE full stack", () => {
  it("exposes device and node public keys via API", async () => {
    const me = await api<MeResponse>("GET", "/api/me");
    expect(me.e2ee?.publicKey).toBe(phoneKey.publicKey);
    expect(me.e2ee?.devicePublicKeys).toEqual([phoneKey.publicKey]);

    const nodes = await waitAsync(async () => {
      const ns = await api<NodeInfo[]>("GET", "/api/nodes");
      return ns.length && ns[0]!.online ? ns : null;
    }, "node online");
    expect(nodes[0]!.publicKey).toBe(daemon.publicKey);
  });

  it("keeps prompts, diffs, approvals, and follow-ups blind to the hub while running the full loop", async () => {
    const SECRET_TITLE = "SECRET_TITLE_ALPHA";
    const SECRET_PROMPT = "SECRET_PROMPT_OMEGA 写一个 hello.txt";
    const SECRET_FOLLOWUP = "SECRET_FOLLOWUP_SIGMA 再改一次";

    const nodes = await api<NodeInfo[]>("GET", "/api/nodes");
    const nodePub = nodes[0]!.publicKey!;
    const { e2ee } = encryptTaskPayload({ title: SECRET_TITLE, prompt: SECRET_PROMPT }, phoneKey, [nodePub], "demo");

    const task = await api<Task>("POST", "/api/tasks", {
      project: "demo",
      title: ENCRYPTED_TASK_TITLE,
      prompt: ENCRYPTED_PLACEHOLDER,
      constraints: { agent: "acp:mock" },
      e2ee,
    });
    expect(task.title).toBe(ENCRYPTED_TASK_TITLE);
    expect(task.prompt).toBe(ENCRYPTED_PLACEHOLDER);

    // Phone recovers DEK from the hub-stored task (no local cache required).
    const recovered = decryptTaskPayload(task.e2ee!, phoneKey, task.project);
    expect(recovered.title).toBe(SECRET_TITLE);
    expect(recovered.prompt).toBe(SECRET_PROMPT);
    const dek = recovered.dek;

    const decryptAll = (envs: EventEnvelope[]) =>
      envs.map((env) =>
        env.event.type === "encrypted" ? { ...env, event: decryptEvent(dek, env.runId, env.seq, env.event) } : env,
      );

    // Wait for approval request.
    const waiting = await waitAsync(async () => {
      const d = await api<{ task: Task; runs: Run[] }>("GET", `/api/tasks/${task.id}`);
      return d.task.state === "waiting_approval" ? d : null;
    }, "waiting_approval");
    const runId = waiting.task.runId!;

    // Push notification fired for approval, with redacted body (no secret leak).
    await hub.notifier!.flush();
    const apprPush = pushCalls.find((c) => c.body.kind === "approval" && c.body.data.taskId === task.id);
    expect(apprPush).toBeDefined();
    expect(apprPush!.body.body).toBe("有一个操作等待你审批");

    const rawEvents1 = await api<EventEnvelope[]>("GET", `/api/runs/${runId}/events`);
    expect(rawEvents1.every((e) => e.event.type === "encrypted")).toBe(true);
    const plainEvents1 = decryptAll(rawEvents1);
    const apprEv = plainEvents1.find((e) => e.event.type === "approval.requested");
    expect(apprEv?.event).toMatchObject({ type: "approval.requested", risk: "write", title: "写入 hello.txt" });
    const approvalId = apprEv!.event.type === "approval.requested" ? apprEv!.event.approvalId : "";

    // Unencrypted / forged approval attempt is ignored by the node.
    await api("POST", `/api/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, { optionId: "allow" });
    await new Promise((r) => setTimeout(r, 150));
    expect((await api<{ task: Task }>("GET", `/api/tasks/${task.id}`)).task.state).toBe("waiting_approval");

    // Genuine encrypted approval succeeds.
    await api("POST", `/api/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, {
      optionId: ENCRYPTED_PLACEHOLDER,
      e2ee: encryptApproval(dek, runId, approvalId, "allow"),
    });

    const review = await waitAsync(async () => {
      const d = await api<{ task: Task; runs: Run[] }>("GET", `/api/tasks/${task.id}`);
      return d.task.state === "review" ? d : null;
    }, "review");

    // Follow-up input encrypted; replaying the exact same box is ignored.
    const lastSeq = (await api<EventEnvelope[]>("GET", `/api/runs/${runId}/events`)).at(-1)!.seq;
    const followBox = encryptInput(dek, runId, SECRET_FOLLOWUP);
    await api("POST", `/api/runs/${runId}/input`, { text: ENCRYPTED_PLACEHOLDER, e2ee: followBox });

    // Approve turn 2.
    const turn2Appr = await waitAsync(async () => {
      const evs = decryptAll(await api<EventEnvelope[]>("GET", `/api/runs/${runId}/events?after=${lastSeq}`));
      return evs.find((e) => e.event.type === "approval.requested");
    }, "turn 2 approval");
    const appr2Id = turn2Appr.event.type === "approval.requested" ? turn2Appr.event.approvalId : "";
    await api("POST", `/api/runs/${runId}/approvals/${encodeURIComponent(appr2Id)}`, {
      optionId: ENCRYPTED_PLACEHOLDER,
      e2ee: encryptApproval(dek, runId, appr2Id, "allow"),
    });

    const wt = review.runs[0]!.worktree!;
    await waitAsync(async () => {
      const d = await api<{ task: Task }>("GET", `/api/tasks/${task.id}`);
      return d.task.state === "review" && readFileSync(join(wt, "hello.txt"), "utf8").includes("turn 2");
    }, "turn 2 review");

    // Replaying followBox must NOT trigger a turn 3.
    await api("POST", `/api/runs/${runId}/input`, { text: ENCRYPTED_PLACEHOLDER, e2ee: followBox });
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(join(wt, "hello.txt"), "utf8")).not.toContain("turn 3");

    // Hub DB/events must contain ZERO plaintext secrets.
    const allRawEvents = await api<EventEnvelope[]>("GET", `/api/runs/${runId}/events`);
    const hubDump = JSON.stringify({ task: hub.store.getTask(task.id), runs: hub.store.runsForTask(task.id), events: allRawEvents, pushCalls });
    for (const secret of [SECRET_TITLE, SECRET_PROMPT, SECRET_FOLLOWUP, "hello.txt", "turn 1", "turn 2", "写入 hello.txt"]) {
      expect(hubDump).not.toContain(secret);
    }

    // Decrypted diff is intact on the phone side.
    const allPlain = decryptAll(allRawEvents);
    const diff = allPlain.findLast((e) => e.event.type === "diff.updated")?.event;
    expect(diff?.type).toBe("diff.updated");
    if (diff?.type === "diff.updated") expect(diff.unified).toContain("hello.txt");

    // Commit on node uses the decrypted real title.
    const commit = await api<{ ok: boolean }>("POST", `/api/runs/${runId}/actions`, { action: "commit" });
    expect(commit.ok).toBe(true);
    const gitLog = execFileSync("git", ["-C", repo, "log", "--oneline", review.runs[0]!.branch!]).toString();
    expect(gitLog).toContain(`agentfleet: ${SECRET_TITLE}`);
  });

  it("enforces scheduler key matching, required mode, and trustedDevices", async () => {
    // 1) Plaintext task is rejected by node in required mode.
    const plain = await api<Task>("POST", "/api/tasks", { project: "demo", prompt: "plaintext", constraints: { agent: "acp:mock" } });
    const failedPlain = await waitAsync(async () => {
      const d = await api<{ task: Task }>("GET", `/api/tasks/${plain.id}`);
      return d.task.state === "failed" ? d : null;
    }, "plaintext rejected");
    expect(failedPlain.task.note).toContain("端到端加密");

    // 2) Encrypted task from an untrusted device keypair is rejected by node.
    const roguePhone = generateKeyPair();
    const { e2ee: rogueEnc } = encryptTaskPayload({ title: "rogue", prompt: "p" }, roguePhone, [daemon.publicKey], "demo");
    const rogueTask = await api<Task>("POST", "/api/tasks", {
      project: "demo",
      prompt: ENCRYPTED_PLACEHOLDER,
      constraints: { agent: "acp:mock" },
      e2ee: rogueEnc,
    });
    const failedRogue = await waitAsync(async () => {
      const d = await api<{ task: Task }>("GET", `/api/tasks/${rogueTask.id}`);
      return d.task.state === "failed" ? d : null;
    }, "rogue device rejected");
    expect(failedRogue.task.note).toContain("信任列表");

    // 3) Encrypted task wrapped for a different node stays queued with a clear reason.
    const otherNode = generateKeyPair();
    const { e2ee: otherEnc } = encryptTaskPayload({ title: "other", prompt: "p" }, phoneKey, [otherNode.publicKey], "demo");
    const queuedTask = await api<Task>("POST", "/api/tasks", {
      project: "demo",
      prompt: ENCRYPTED_PLACEHOLDER,
      constraints: { agent: "acp:mock" },
      e2ee: otherEnc,
    });
    expect(queuedTask.state).toBe("queued");
    expect(queuedTask.note).toContain("加密任务密钥");
  });
});
