/**
 * Runner — owns every run on this node.
 *
 *   run.assign  -> git worktree -> adapter session -> turn loop -> run.ended
 *   run.input   -> follow-up turn (re-opens a completed run; revives the agent
 *                  session in the same worktree if it was closed)
 *   approvals   -> node-local Policy first; only "ask" goes to the phone
 *   run.action  -> commit / push / pr / discard on the run's worktree
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decryptApproval,
  decryptInput,
  decryptTaskPayload,
  encryptEvent,
  fromBase64,
  toBase64,
  type ApprovalOption,
  type FleetEvent,
  type KeyPair,
  type NodeToHub,
  type RunAction,
  type RunSpec,
  type RunStatus,
  type SealedBox,
} from "@agentfleet/proto";
import type { AgentAdapter, AgentSession, ApprovalRequest, TurnResult } from "./adapters/types.ts";
import type { NodeConfig } from "./config.ts";
import { Policy, optionFor } from "./policy.ts";
import { type Worktree, Worktrees } from "./worktree.ts";

/** What survives a daemon restart (so post-run actions & follow-ups still work). */
interface RunMeta {
  spec: RunSpec;
  repoPath: string;
  wt: Worktree;
  seq: number;
  /** Base64 32-byte task DEK when the run is end-to-end encrypted. */
  e2eeDek?: string;
  /** Decrypted task title for commit messages / PR titles. */
  e2eeTitle?: string;
  /** Seen input message ids to reject hub replays on encrypted runs. */
  seenInputIds?: string[];
}

interface PendingApproval {
  options: ApprovalOption[];
  resolve: (optionId: string | null) => void;
  timer: NodeJS.Timeout;
}

interface RunState {
  meta: RunMeta;
  session: AgentSession | null;
  starting: Promise<AgentSession> | null;
  queue: string[];
  turnActive: boolean;
  /** run.ended has been sent for the current open period. */
  ended: boolean;
  interruptRequested: boolean;
  approvals: Map<string, PendingApproval>;
  idleTimer: NodeJS.Timeout | null;
}

type TextEvent = Extract<FleetEvent, { type: "message.delta" | "reasoning.delta" }>;

/** Consecutive text deltas are merged for up to this long before being sent. */
const TEXT_COALESCE_MS = 120;

function sameStream(a: TextEvent, b: FleetEvent): b is TextEvent {
  if (a.type !== b.type) return false;
  return a.type !== "message.delta" || (b.type === "message.delta" && a.role === b.role);
}

export interface RunnerOptions {
  cfg: NodeConfig;
  adapters: Map<string, AgentAdapter>;
  send: (msg: NodeToHub) => void;
  /** Path of the persisted run metadata file. */
  statePath: string;
  /** Node's X25519 identity keypair for decrypting E2EE tasks. */
  identity?: KeyPair;
  log?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
}

export class Runner {
  private runs = new Map<string, RunState>();
  private metas: Record<string, RunMeta>;
  private policy: Policy;
  private worktrees: Worktrees;
  private log: NonNullable<RunnerOptions["log"]>;
  private pendingText = new Map<string, { meta: RunMeta; event: TextEvent; timer: NodeJS.Timeout }>();

  constructor(private opts: RunnerOptions) {
    this.policy = new Policy(opts.cfg.policy);
    this.worktrees = new Worktrees(opts.cfg.workRoot);
    this.log = opts.log ?? ((level, text) => (level === "debug" ? undefined : console.error(`[${level}] ${text}`)));
    this.metas = loadMetas(opts.statePath);
  }

  /** Runs the hub should consider alive (not yet reported as ended). */
  activeRunIds(): string[] {
    return [...this.runs.entries()].filter(([, s]) => !s.ended).map(([id]) => id);
  }

  get running(): number {
    return this.activeRunIds().length;
  }

  // ---------------------------------------------------------------- hub -> node

  async assign(spec: RunSpec): Promise<void> {
    if (this.runs.has(spec.runId) || this.metas[spec.runId]) return; // duplicate assign after reconnect
    const fail = (error: string) => {
      this.log("warn", `run ${spec.runId} failed to start: ${error}`);
      this.opts.send({ type: "run.ended", runId: spec.runId, status: "failed", error });
    };
    const adapter = this.opts.adapters.get(spec.runtimeId);
    if (!adapter) return fail(`本节点没有 agent "${spec.runtimeId}"`);
    const project = this.opts.cfg.projects[spec.project];
    if (!project) return fail(`本节点未配置项目 "${spec.project}"（agentfleet-node project add）`);

    const e2eeCfg = this.opts.cfg.e2ee;
    let localSpec = spec;
    let e2eeDek: string | undefined;
    let e2eeTitle: string | undefined;
    if (spec.e2ee) {
      if (!this.opts.identity) return fail("节点未配置端到端加密密钥");
      if (e2eeCfg.trustedDevices.length > 0 && !e2eeCfg.trustedDevices.includes(spec.e2ee.spk)) {
        return fail("发送方设备公钥未在节点信任列表中");
      }
      try {
        const dec = decryptTaskPayload(spec.e2ee, this.opts.identity, spec.project);
        e2eeDek = toBase64(dec.dek);
        e2eeTitle = dec.title;
        localSpec = { ...spec, prompt: dec.prompt, e2ee: undefined };
      } catch (err) {
        return fail(`解密端到端加密任务失败: ${(err as Error).message}`);
      }
    } else if (e2eeCfg.mode === "required") {
      return fail("本节点要求端到端加密，拒绝明文任务");
    }

    let wt: Worktree;
    try {
      wt = await this.worktrees.create(project.path, spec.project, spec.runId, project.baseRef);
    } catch (err) {
      return fail(`创建 worktree 失败: ${(err as Error).message}`);
    }
    const meta: RunMeta = {
      spec: localSpec,
      repoPath: project.path,
      wt,
      seq: 0,
      ...(e2eeDek ? { e2eeDek, e2eeTitle, seenInputIds: [] } : {}),
    };
    this.metas[spec.runId] = meta;
    this.persist();
    const st = this.newState(meta);
    st.ended = false;
    this.runs.set(spec.runId, st);
    this.opts.send({ type: "run.started", runId: spec.runId, branch: wt.branch, worktree: wt.path });
    this.emit(st, { type: "run.status", status: "starting", detail: `${localSpec.runtimeId} @ ${wt.branch}` });
    st.queue.push(localSpec.prompt);
    void this.pump(st);
  }

  input(runId: string, text: string, e2ee?: SealedBox) {
    const st = this.stateFor(runId);
    if (!st) {
      this.log("warn", `input for unknown run ${runId}`);
      return;
    }
    let plain = text;
    if (st.meta.e2eeDek) {
      if (!e2ee) {
        this.log("warn", `rejected unencrypted input for E2EE run ${runId}`);
        return;
      }
      try {
        const dec = decryptInput(fromBase64(st.meta.e2eeDek), runId, e2ee);
        const seen = (st.meta.seenInputIds ??= []);
        if (seen.includes(dec.msgId)) {
          this.log("warn", `rejected replayed input ${dec.msgId} for run ${runId}`);
          return;
        }
        seen.push(dec.msgId);
        if (seen.length > 500) seen.splice(0, seen.length - 500);
        this.persist();
        plain = dec.text;
      } catch (err) {
        this.log("warn", `rejected invalid E2EE input for run ${runId}: ${(err as Error).message}`);
        return;
      }
    } else if (this.opts.cfg.e2ee.mode === "required") {
      this.log("warn", `rejected plaintext input in E2EE required mode for run ${runId}`);
      return;
    }
    st.queue.push(plain);
    void this.pump(st);
  }

  approval(runId: string, approvalId: string, optionId: string, e2ee?: SealedBox) {
    const st = this.runs.get(runId);
    const p = st?.approvals.get(approvalId);
    if (!st || !p) return;
    let resolvedOption = optionId;
    if (st.meta.e2eeDek) {
      if (!e2ee) {
        this.log("warn", `rejected unencrypted approval for E2EE run ${runId}`);
        return;
      }
      try {
        resolvedOption = decryptApproval(fromBase64(st.meta.e2eeDek), runId, approvalId, e2ee);
      } catch (err) {
        this.log("warn", `rejected invalid E2EE approval for run ${runId}/${approvalId}: ${(err as Error).message}`);
        return;
      }
    } else if (this.opts.cfg.e2ee.mode === "required") {
      this.log("warn", `rejected plaintext approval in E2EE required mode for run ${runId}`);
      return;
    }
    if (!p.options.some((o) => o.id === resolvedOption)) {
      this.emit(st, { type: "log", level: "warn", text: `无效的审批选项 ${resolvedOption}` });
      return;
    }
    clearTimeout(p.timer);
    st.approvals.delete(approvalId);
    this.emit(st, { type: "approval.resolved", approvalId, optionId: resolvedOption, by: "user" });
    p.resolve(resolvedOption);
  }

  async interrupt(runId: string) {
    const st = this.runs.get(runId);
    if (!st || st.ended) return;
    st.interruptRequested = true;
    st.queue.length = 0;
    this.cancelApprovals(st);
    if (st.session && st.turnActive) await st.session.interrupt().catch(() => {});
  }

  async action(runId: string, action: RunAction, requestId: string) {
    const reply = (ok: boolean, output: string, url?: string) =>
      this.opts.send({ type: "run.action.result", requestId, runId, ok, output, url });
    const meta = this.metas[runId];
    if (!meta) return reply(false, "本节点没有该运行的记录（worktree 可能已被删除）");
    const st = this.runs.get(runId);
    if (st?.turnActive) return reply(false, "agent 仍在运行，请先等待完成或中断");
    const title = meta.e2eeTitle?.trim() || firstLine(meta.spec.prompt);
    try {
      switch (action) {
        case "commit": {
          const out = await this.worktrees.commit(meta.wt, `agentfleet: ${title}`);
          await this.emitDiff(runId);
          return reply(true, out.trim());
        }
        case "push": {
          const c = await this.worktrees.commit(meta.wt, `agentfleet: ${title}`);
          const p = await this.worktrees.push(meta.wt);
          return reply(true, [c.trim(), p].filter(Boolean).join("\n"));
        }
        case "pr": {
          await this.worktrees.commit(meta.wt, `agentfleet: ${title}`);
          await this.worktrees.push(meta.wt);
          const body = `由 AgentFleet 创建（agent: ${meta.spec.runtimeId}, run: ${runId}）\n\n> ${meta.spec.prompt.replace(/\n/g, "\n> ")}`;
          const r = await this.worktrees.pr(meta.wt, title, body);
          return reply(true, r.output, r.url);
        }
        case "discard": {
          if (st) await this.closeSession(st);
          this.runs.delete(runId);
          const out = await this.worktrees.remove(meta.repoPath, meta.wt);
          delete this.metas[runId];
          this.persist();
          return reply(true, out);
        }
      }
    } catch (err) {
      return reply(false, (err as Error).message);
    } finally {
      if (this.metas[runId]) this.persist();
    }
  }

  async shutdown() {
    for (const runId of [...this.pendingText.keys()]) this.flushText(runId);
    await Promise.all([...this.runs.values()].map((st) => this.closeSession(st)));
    this.persist();
  }

  // ---------------------------------------------------------------- internals

  private newState(meta: RunMeta): RunState {
    return {
      meta,
      session: null,
      starting: null,
      queue: [],
      turnActive: false,
      ended: true,
      interruptRequested: false,
      approvals: new Map(),
      idleTimer: null,
    };
  }

  /** Live state, or revived from persisted metadata (e.g. follow-up after a daemon restart). */
  private stateFor(runId: string): RunState | null {
    const live = this.runs.get(runId);
    if (live) return live;
    const meta = this.metas[runId];
    if (!meta || !existsSync(meta.wt.path)) return null;
    const st = this.newState(meta);
    this.runs.set(runId, st);
    return st;
  }

  private async ensureSession(st: RunState): Promise<AgentSession> {
    if (st.session) return st.session;
    if (st.starting) return st.starting;
    const adapter = this.opts.adapters.get(st.meta.spec.runtimeId);
    if (!adapter) throw new Error(`本节点没有 agent "${st.meta.spec.runtimeId}"`);
    st.starting = adapter.start(st.meta.spec, {
      cwd: st.meta.wt.path,
      emit: (e) => this.emit(st, e),
      requestApproval: (req) => this.requestApproval(st, req),
      log: (level, text) => {
        this.log(level, `[run ${st.meta.spec.runId.slice(0, 8)}] ${text}`);
        if (level !== "debug") this.emit(st, { type: "log", level, text });
      },
    });
    try {
      st.session = await st.starting;
      return st.session;
    } finally {
      st.starting = null;
    }
  }

  private async pump(st: RunState): Promise<void> {
    if (st.turnActive) return;
    const runId = st.meta.spec.runId;
    while (st.queue.length > 0) {
      const text = st.queue.shift()!;
      st.turnActive = true;
      if (st.idleTimer) clearTimeout(st.idleTimer), (st.idleTimer = null);
      if (st.ended) {
        // Re-open a completed run for a follow-up turn.
        st.ended = false;
        st.interruptRequested = false;
        this.opts.send({ type: "run.started", runId, branch: st.meta.wt.branch, worktree: st.meta.wt.path });
      }
      this.emit(st, { type: "message.delta", role: "user", text });

      let result: TurnResult;
      try {
        const session = await this.ensureSession(st);
        if (st.interruptRequested) result = { status: "interrupted" };
        else {
          this.emit(st, { type: "run.status", status: "running" });
          result = await session.prompt(text);
        }
      } catch (err) {
        result = { status: "failed", error: (err as Error).message };
      }
      if (st.interruptRequested && result.status === "completed") result = { status: "interrupted" };
      this.cancelApprovals(st);
      await this.emitDiff(runId);
      st.turnActive = false;

      if (result.status === "completed" && st.queue.length > 0) continue;
      this.endPeriod(st, result.status, result.error ?? null);
      return;
    }
  }

  private endPeriod(st: RunState, status: RunStatus, error: string | null) {
    const runId = st.meta.spec.runId;
    this.emit(st, { type: "run.status", status, detail: error ?? undefined });
    st.ended = true;
    st.queue.length = 0;
    this.persist();
    const wireError = error && st.meta.e2eeDek ? "任务执行失败（详情已端到端加密）" : error;
    this.opts.send({ type: "run.ended", runId, status, error: wireError });
    if (status === "completed") {
      // Keep the agent warm for follow-ups, then free resources.
      st.idleTimer = setTimeout(() => void this.closeSession(st), this.opts.cfg.idleSessionMinutes * 60_000);
      st.idleTimer.unref?.();
    } else {
      void this.closeSession(st);
    }
  }

  private async closeSession(st: RunState) {
    if (st.idleTimer) clearTimeout(st.idleTimer), (st.idleTimer = null);
    this.cancelApprovals(st);
    const s = st.session;
    st.session = null;
    if (s) await s.close().catch(() => {});
  }

  private async requestApproval(st: RunState, req: ApprovalRequest): Promise<string | null> {
    const verdict = this.policy.evaluate(req);
    const approvalId = randomUUID();
    this.emit(st, {
      type: "approval.requested",
      approvalId,
      toolId: req.toolId,
      title: req.title,
      risk: verdict.risk,
      command: req.command,
      cwd: req.cwd,
      diffs: req.diffs,
      reason: verdict.rule ? `${req.reason ?? ""} [policy: ${verdict.rule}]`.trim() : req.reason,
      options: req.options,
    });

    if (st.interruptRequested) {
      this.emit(st, { type: "approval.resolved", approvalId, optionId: null, by: "cancelled" });
      return null;
    }
    if (verdict.decision !== "ask") {
      const optionId = optionFor(verdict.decision, req.options);
      this.emit(st, { type: "approval.resolved", approvalId, optionId, by: optionId ? "policy" : "cancelled" });
      return optionId;
    }

    this.emit(st, { type: "run.status", status: "waiting_approval", detail: req.title });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        st.approvals.delete(approvalId);
        this.emit(st, { type: "approval.resolved", approvalId, optionId: null, by: "cancelled" });
        resolve(null);
      }, this.opts.cfg.policy.approvalTimeoutMinutes * 60_000);
      timer.unref?.();
      st.approvals.set(approvalId, {
        options: req.options,
        timer,
        resolve: (id) => {
          if (st.approvals.size === 0 && !st.ended) this.emit(st, { type: "run.status", status: "running" });
          resolve(id);
        },
      });
    });
  }

  private cancelApprovals(st: RunState) {
    for (const [approvalId, p] of st.approvals) {
      clearTimeout(p.timer);
      this.emit(st, { type: "approval.resolved", approvalId, optionId: null, by: "cancelled" });
      p.resolve(null);
    }
    st.approvals.clear();
  }

  private async emitDiff(runId: string) {
    const meta = this.metas[runId];
    if (!meta) return;
    try {
      const d = await this.worktrees.diff(meta.wt);
      this.emitMeta(meta, { type: "diff.updated", ...d });
    } catch (err) {
      this.emitMeta(meta, { type: "log", level: "warn", text: `计算 diff 失败: ${(err as Error).message}` });
    }
  }

  private emit(st: RunState, event: FleetEvent) {
    this.emitMeta(st.meta, event);
  }

  private emitMeta(meta: RunMeta, event: FleetEvent) {
    const runId = meta.spec.runId;
    const pending = this.pendingText.get(runId);
    const isText = event.type === "message.delta" || event.type === "reasoning.delta";
    if (isText && pending && sameStream(pending.event, event)) {
      pending.event.text += event.text;
      return;
    }
    if (pending) this.flushText(runId);
    if (isText) {
      const timer = setTimeout(() => this.flushText(runId), TEXT_COALESCE_MS);
      timer.unref?.();
      this.pendingText.set(runId, { meta, event: { ...(event as TextEvent) }, timer });
      return;
    }
    this.sendEvent(meta, event);
  }

  private flushText(runId: string) {
    const p = this.pendingText.get(runId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingText.delete(runId);
    this.sendEvent(p.meta, p.event);
  }

  private sendEvent(meta: RunMeta, event: FleetEvent) {
    const seq = meta.seq++;
    const wireEvent = meta.e2eeDek ? encryptEvent(fromBase64(meta.e2eeDek), meta.spec.runId, seq, event) : event;
    this.opts.send({ type: "run.event", runId: meta.spec.runId, seq, ts: Date.now(), event: wireEvent });
  }

  private persist() {
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      writeFileSync(this.opts.statePath, JSON.stringify(this.metas, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log("warn", `保存运行状态失败: ${(err as Error).message}`);
    }
  }
}

function loadMetas(path: string): Record<string, RunMeta> {
  try {
    const metas = JSON.parse(readFileSync(path, "utf8")) as Record<string, RunMeta>;
    // Events emitted before a crash may not have been persisted; jump ahead so the
    // hub's (runId, seq) dedupe never swallows new events.
    for (const m of Object.values(metas)) m.seq += 10_000;
    return metas;
  } catch {
    return {};
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim().slice(0, 72) || "update";
}
