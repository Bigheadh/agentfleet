/**
 * Hub core: node registry, task queue, run lifecycle and event fan-out.
 * Transport-agnostic — server.ts wires it to HTTP/WebSocket.
 */
import {
  type CreateTaskRequest,
  CreateTaskRequest as CreateTaskRequestSchema,
  type EventEnvelope,
  type HubToClient,
  type HubToNode,
  type NodeInfo,
  type NodeToHub,
  PROTOCOL_VERSION,
  type Project,
  type Run,
  type RunAction,
  type RunActionResponse,
  type Task,
  TaskConstraints,
} from "@agentfleet/proto";
import { explainNoMatch, queueOrder, rankCandidates } from "./scheduler.ts";
import { newId, type Store } from "./store.ts";

export interface NodeConn {
  send(msg: HubToNode): void;
  close(code?: number, reason?: string): void;
}

export interface ClientConn {
  send(msg: HubToClient): void;
  subs: Set<string>;
}

export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HubOptions {
  name: string;
  /** How long a disconnected node keeps its runs before they're failed and requeued. */
  nodeGraceMs?: number;
  maxAttempts?: number;
  actionTimeoutMs?: number;
}

interface NodeEntry {
  info: NodeInfo;
  conn: NodeConn | null;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_TASK_STATES = new Set<Task["state"]>(["done", "failed", "cancelled"]);

export class Hub {
  readonly name: string;
  private nodes = new Map<string, NodeEntry>();
  private clients = new Set<ClientConn>();
  private pendingActions = new Map<
    string,
    { resolve: (r: RunActionResponse) => void; timer: ReturnType<typeof setTimeout>; action: RunAction; taskId: string }
  >();
  private opts: Required<HubOptions>;

  constructor(
    readonly store: Store,
    opts: HubOptions,
  ) {
    this.opts = { nodeGraceMs: 60_000, maxAttempts: 3, actionTimeoutMs: 120_000, ...opts };
    this.name = opts.name;
    for (const info of store.listNodeInfos()) {
      this.nodes.set(info.id, { info: { ...info, online: false }, conn: null });
    }
  }

  // ======================================================================
  // Node side
  // ======================================================================

  nodeConnected(nodeId: string, conn: NodeConn) {
    const existing = this.nodes.get(nodeId);
    if (existing?.conn && existing.conn !== conn) existing.conn.close(4000, "replaced by new connection");
    if (existing?.graceTimer) clearTimeout(existing.graceTimer);
    // `info` is filled in on `hello`.
    this.nodes.set(nodeId, { info: existing?.info ?? placeholderNode(nodeId), conn });
  }

  nodeDisconnected(nodeId: string, conn: NodeConn) {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.conn !== conn) return;
    entry.conn = null;
    entry.info = { ...entry.info, online: false, lastSeen: Date.now() };
    this.store.saveNodeInfo(entry.info);
    this.emit({ type: "node", node: entry.info });
    entry.graceTimer = setTimeout(() => {
      for (const run of this.store.activeRunsOnNode(nodeId)) {
        this.finishRun(run, "failed", "节点离线超时", { requeue: true });
      }
    }, this.opts.nodeGraceMs);
  }

  nodeMessage(nodeId: string, msg: NodeToHub) {
    const entry = this.nodes.get(nodeId);
    if (!entry?.conn) return;
    switch (msg.type) {
      case "hello": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          entry.conn.send({ type: "error", message: `protocol version mismatch: hub=${PROTOCOL_VERSION} node=${msg.protocolVersion}` });
          entry.conn.close(4002, "protocol mismatch");
          return;
        }
        entry.info = {
          ...msg.node,
          id: nodeId,
          online: true,
          lastSeen: Date.now(),
          running: 0,
        };
        // Reconcile runs the hub thinks are alive on this node.
        const alive = new Set(msg.activeRuns);
        for (const run of this.store.activeRunsOnNode(nodeId)) {
          if (!alive.has(run.id)) this.finishRun(run, "failed", "节点重启，运行已丢失", { requeue: true });
        }
        this.refreshRunning(nodeId);
        entry.conn.send({ type: "welcome", nodeId, hubName: this.name });
        this.schedule();
        return;
      }
      case "heartbeat":
        entry.info.lastSeen = Date.now();
        return;
      case "capabilities":
        entry.info = { ...entry.info, runtimes: msg.runtimes, projects: msg.projects, lastSeen: Date.now() };
        this.store.saveNodeInfo(entry.info);
        this.emit({ type: "node", node: entry.info });
        this.schedule();
        return;
      case "run.started": {
        const run = this.store.getRun(msg.runId);
        if (!run) return;
        // A completed run is "reopened" when the user sends a follow-up prompt (multi-turn).
        if (run.endedAt !== null && run.status !== "completed") return;
        this.saveRun({ ...run, status: "running", branch: msg.branch, worktree: msg.worktree, endedAt: null, error: null });
        this.updateTask(run.taskId, { state: "running", note: null });
        this.refreshRunning(run.nodeId);
        return;
      }
      case "run.event":
        this.onRunEvent({ runId: msg.runId, seq: msg.seq, ts: msg.ts, event: msg.event });
        return;
      case "run.ended": {
        const run = this.store.getRun(msg.runId);
        if (!run || run.endedAt !== null) return;
        this.finishRun(run, msg.status, msg.error, { requeue: false });
        return;
      }
      case "run.action.result": {
        const pending = this.pendingActions.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingActions.delete(msg.requestId);
        if (msg.ok) {
          if (pending.action === "pr" || pending.action === "push") this.updateTask(pending.taskId, { state: "done" });
          if (pending.action === "discard") this.updateTask(pending.taskId, { state: "cancelled" });
        }
        pending.resolve({ ok: msg.ok, output: msg.output, url: msg.url });
        return;
      }
    }
  }

  private onRunEvent(env: EventEnvelope) {
    const run = this.store.getRun(env.runId);
    if (!run) return;
    if (!this.store.appendEvent(env)) return; // duplicate
    let next: Run = { ...run, lastSeq: Math.max(run.lastSeq, env.seq) };
    const e = env.event;
    if (e.type === "approval.requested") {
      next = { ...next, pendingApprovals: next.pendingApprovals + 1, status: "waiting_approval" };
      this.updateTask(run.taskId, { state: "waiting_approval" });
    } else if (e.type === "approval.resolved") {
      const pending = Math.max(0, next.pendingApprovals - 1);
      next = { ...next, pendingApprovals: pending, status: pending === 0 ? "running" : next.status };
      if (pending === 0) this.updateTask(run.taskId, { state: "running" });
    } else if (e.type === "run.status" && next.endedAt === null) {
      next = { ...next, status: e.status };
    }
    this.saveRun(next);
    for (const c of this.clients) if (c.subs.has(env.runId)) c.send({ type: "event", envelope: env });
  }

  private finishRun(run: Run, status: Run["status"], error: string | null, { requeue }: { requeue: boolean }) {
    const ended: Run = { ...run, status, error, endedAt: Date.now(), pendingApprovals: 0 };
    this.saveRun(ended);
    const task = this.store.getTask(run.taskId);
    if (task && task.runId === run.id && !TERMINAL_TASK_STATES.has(task.state)) {
      if (status === "completed") this.updateTask(task.id, { state: "review", note: null });
      else if (requeue && task.attempts < this.opts.maxAttempts) this.updateTask(task.id, { state: "queued", note: error });
      else if (status === "interrupted") this.updateTask(task.id, { state: "cancelled", note: error });
      else this.updateTask(task.id, { state: "failed", note: error });
    }
    this.refreshRunning(run.nodeId);
    this.schedule();
  }

  private refreshRunning(nodeId: string) {
    const entry = this.nodes.get(nodeId);
    if (!entry) return;
    entry.info = { ...entry.info, running: this.store.activeRunsOnNode(nodeId).length };
    this.store.saveNodeInfo(entry.info);
    this.emit({ type: "node", node: entry.info });
  }

  // ======================================================================
  // Scheduling
  // ======================================================================

  schedule() {
    const queued = this.store.tasksInState("queued").sort(queueOrder);
    for (const task of queued) {
      const nodes = this.nodeInfos();
      const [best] = rankCandidates(task, nodes);
      if (!best) {
        const note = explainNoMatch(task, nodes);
        if (task.note !== note) this.updateTask(task.id, { note });
        continue;
      }
      const entry = this.nodes.get(best.node.id)!;
      const run: Run = {
        id: newId(),
        taskId: task.id,
        nodeId: best.node.id,
        runtimeId: best.runtime.id,
        status: "starting",
        branch: null,
        worktree: null,
        startedAt: Date.now(),
        endedAt: null,
        error: null,
        lastSeq: -1,
        pendingApprovals: 0,
      };
      this.saveRun(run);
      this.updateTask(task.id, { state: "assigned", runId: run.id, attempts: task.attempts + 1, note: null });
      this.refreshRunning(best.node.id);
      entry.conn!.send({
        type: "run.assign",
        spec: {
          runId: run.id,
          taskId: task.id,
          project: task.project,
          runtimeId: best.runtime.id,
          prompt: task.prompt,
          model: task.constraints.model,
        },
      });
    }
  }

  // ======================================================================
  // Client side
  // ======================================================================

  addClient(c: ClientConn) {
    this.clients.add(c);
  }

  removeClient(c: ClientConn) {
    this.clients.delete(c);
  }

  subscribe(c: ClientConn, runId: string, after: number) {
    c.subs.add(runId);
    for (const envelope of this.store.eventsAfter(runId, after)) c.send({ type: "event", envelope });
  }

  nodeInfos(): NodeInfo[] {
    return [...this.nodes.values()].map((e) => e.info).filter((n) => n.name !== "");
  }

  projects(): Project[] {
    const map = new Map<string, string[]>();
    for (const n of this.nodeInfos()) for (const p of n.projects) map.set(p, [...(map.get(p) ?? []), n.id]);
    return [...map.entries()].map(([id, nodes]) => ({ id, nodes })).sort((a, b) => a.id.localeCompare(b.id));
  }

  createTask(input: CreateTaskRequest, actor: string): Task {
    const req = CreateTaskRequestSchema.parse(input);
    const now = Date.now();
    const task: Task = {
      id: newId(),
      project: req.project,
      title: req.title?.trim() || req.prompt.split("\n")[0]!.slice(0, 80),
      prompt: req.prompt,
      priority: req.priority,
      constraints: TaskConstraints.parse(req.constraints),
      state: "queued",
      createdAt: now,
      updatedAt: now,
      runId: null,
      attempts: 0,
      note: null,
    };
    this.store.saveTask(task);
    this.store.audit(actor, "task.create", task.id);
    this.emit({ type: "task", task });
    this.schedule();
    return this.store.getTask(task.id)!;
  }

  cancelTask(taskId: string, actor: string): Task {
    const task = this.mustTask(taskId);
    if (TERMINAL_TASK_STATES.has(task.state)) return task;
    if (task.runId) {
      const run = this.store.getRun(task.runId);
      if (run && run.endedAt === null) this.nodeConn(run.nodeId)?.send({ type: "run.interrupt", runId: run.id });
    }
    this.store.audit(actor, "task.cancel", taskId);
    return this.updateTask(taskId, { state: "cancelled" })!;
  }

  retryTask(taskId: string, actor: string): Task {
    const task = this.mustTask(taskId);
    if (!["failed", "cancelled", "review"].includes(task.state)) throw new HubError(409, `cannot retry task in state ${task.state}`);
    this.store.audit(actor, "task.retry", taskId);
    const t = this.updateTask(taskId, { state: "queued", note: null })!;
    this.schedule();
    return this.store.getTask(t.id)!;
  }

  sendInput(runId: string, text: string, actor: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new HubError(404, "run not found");
    if (run.endedAt !== null && run.status !== "completed") throw new HubError(409, "run already ended");
    const task = this.store.getTask(run.taskId);
    if (task && task.runId !== run.id) throw new HubError(409, "not the latest run of this task");
    this.store.audit(actor, "run.input", runId);
    this.mustNodeConn(run.nodeId).send({ type: "run.input", runId, text });
  }

  resolveApproval(runId: string, approvalId: string, optionId: string, actor: string) {
    const run = this.mustActiveRun(runId);
    this.store.audit(actor, "run.approval", `${runId}/${approvalId}=${optionId}`);
    this.mustNodeConn(run.nodeId).send({ type: "run.approval", runId, approvalId, optionId });
  }

  interruptRun(runId: string, actor: string) {
    const run = this.mustActiveRun(runId);
    this.store.audit(actor, "run.interrupt", runId);
    this.mustNodeConn(run.nodeId).send({ type: "run.interrupt", runId });
  }

  runAction(runId: string, action: RunAction, actor: string): Promise<RunActionResponse> {
    const run = this.store.getRun(runId);
    if (!run) throw new HubError(404, "run not found");
    if (run.endedAt === null) throw new HubError(409, "run is still active");
    const conn = this.mustNodeConn(run.nodeId);
    this.store.audit(actor, `run.action.${action}`, runId);
    const requestId = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(requestId);
        resolve({ ok: false, output: "节点响应超时" });
      }, this.opts.actionTimeoutMs);
      this.pendingActions.set(requestId, { resolve, timer, action, taskId: run.taskId });
      conn.send({ type: "run.action", runId, action, requestId });
    });
  }

  // ======================================================================
  // helpers
  // ======================================================================

  private emit(msg: HubToClient) {
    for (const c of this.clients) c.send(msg);
  }

  private saveRun(run: Run) {
    this.store.saveRun(run);
    this.emit({ type: "run", run });
  }

  private updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const task = this.store.getTask(id);
    if (!task) return undefined;
    const next = { ...task, ...patch, updatedAt: Date.now() };
    this.store.saveTask(next);
    this.emit({ type: "task", task: next });
    return next;
  }

  private mustTask(id: string): Task {
    const t = this.store.getTask(id);
    if (!t) throw new HubError(404, "task not found");
    return t;
  }

  private mustActiveRun(id: string): Run {
    const r = this.store.getRun(id);
    if (!r) throw new HubError(404, "run not found");
    if (r.endedAt !== null) throw new HubError(409, "run already ended");
    return r;
  }

  private nodeConn(nodeId: string): NodeConn | null {
    return this.nodes.get(nodeId)?.conn ?? null;
  }

  private mustNodeConn(nodeId: string): NodeConn {
    const c = this.nodeConn(nodeId);
    if (!c) throw new HubError(409, "node is offline");
    return c;
  }
}

function placeholderNode(id: string): NodeInfo {
  return { id, name: "", os: "", labels: [], maxConcurrency: 1, running: 0, online: false, lastSeen: Date.now(), runtimes: [], projects: [] };
}
