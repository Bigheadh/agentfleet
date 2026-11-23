/**
 * L1 — native Codex adapter over `codex app-server` (stdio JSON-RPC).
 *
 * Uses the documented thread -> turn -> item model. We deliberately use the
 * stdio transport (the websocket transport is marked experimental/unsupported).
 * Protocol reference: `codex app-server generate-ts --out DIR`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Capability, FileDiff, FleetEvent, RunSpec } from "@agentfleet/proto";
import { JsonRpcError, JsonRpcPeer } from "../jsonrpc.ts";
import { classifyStderr, commandExists, exec, killTree, spawnAgent, versionOf } from "../proc.ts";
import type { AdapterContext, AgentAdapter, AgentCommand, AgentSession, TurnResult } from "./types.ts";

export interface CodexDef extends AgentCommand {
  /** Probe login via `codex login status`; disable for test doubles. */
  probeLogin?: boolean;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

interface ThreadItem {
  type: string;
  id: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind: { type: string }; diff: string }>;
  text?: string;
  summary?: string[];
  server?: string;
  tool?: string;
  query?: string;
}

const APPROVAL_OPTIONS = [
  { id: "accept", label: "允许", kind: "allow_once" as const },
  { id: "acceptForSession", label: "本会话内允许", kind: "allow_always" as const },
  { id: "decline", label: "拒绝", kind: "reject_once" as const },
];

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  constructor(private def: CodexDef = { command: "codex", args: ["app-server"] }) {}

  async probe(): Promise<Capability> {
    const installed = await commandExists(this.def.command);
    let version: string | null = null;
    let loggedIn: boolean | null = null;
    const notes: string[] = [];
    if (installed && this.def.probeLogin !== false) {
      version = await versionOf(this.def.command, ["--version"]);
      loggedIn = (await exec(this.def.command, ["login", "status"], { timeoutMs: 8000 })).code === 0;
      if (!loggedIn) {
        // `codex login status` only knows ChatGPT/API-key logins. A custom
        // model_provider (env_key) or OPENAI_API_KEY works without it.
        const provider = customProvider({ ...process.env, ...this.def.env });
        if (provider) {
          loggedIn = null;
          notes.push(`使用自定义 provider: ${provider}`);
        }
      }
      if (process.platform === "linux" && !(await commandExists("bwrap"))) {
        notes.push("未安装 bubblewrap，Codex 沙箱不可用（apt install bubblewrap）");
      }
    }
    if (!installed) notes.push("未找到 codex 命令（npm i -g @openai/codex）");
    else if (loggedIn === false) notes.push("未登录：在节点上运行 codex login");
    return {
      id: this.id,
      agent: "Codex",
      tier: "native",
      version,
      installed,
      loggedIn,
      models: [],
      supports: ["interactiveApproval", "multiTurn", "resume", "fork", "usageReport", "structuredDiff", "images"],
      note: notes.length ? notes.join("；") : undefined,
    };
  }

  async start(spec: RunSpec, ctx: AdapterContext): Promise<AgentSession> {
    const child = spawnAgent(this.def.command, this.def.args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...this.def.env },
      onStderr: (line) => {
        const { level, text } = classifyStderr(line);
        ctx.log(level, `[codex] ${text}`);
      },
    });
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code, sig) => resolve(`codex app-server exited (code=${code}, signal=${sig})`));
      child.once("error", (err) => resolve(`failed to start codex: ${err.message}`));
    });
    const peer = new JsonRpcPeer(child.stdin!, child.stdout!);
    peer.onProtocolError = (line) => ctx.log("warn", `[codex] non-JSON output: ${line.slice(0, 200)}`);
    const mapper = new CodexEventMapper(ctx);
    const turnWaiters = new Map<string, (r: TurnResult) => void>();
    /** turn/completed can arrive in the same tick as the turn/start response (readline batches lines). */
    const earlyResults = new Map<string, TurnResult>();
    let threadId = "";
    let currentTurn: string | null = null;

    peer.onNotification = (method, params) => {
      const done = mapper.map(method, params as Record<string, unknown>);
      if (!done) return;
      const waiter = turnWaiters.get(done.turnId);
      if (waiter) waiter(done.result);
      else earlyResults.set(done.turnId, done.result);
    };
    peer.onRequest = async (method, raw) => {
      const p = raw as Record<string, unknown>;
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const command = (p.command as string | undefined) ?? mapper.item(p.itemId as string)?.command;
          const optionId = await ctx.requestApproval({
            toolId: p.itemId as string,
            title: command ? `运行命令: ${command}` : "运行命令",
            risk: "exec",
            command,
            cwd: p.cwd as string | undefined,
            reason: (p.reason as string | undefined) ?? undefined,
            options: APPROVAL_OPTIONS,
          });
          return { decision: optionId ?? "cancel" };
        }
        case "item/fileChange/requestApproval": {
          const item = mapper.item(p.itemId as string);
          const optionId = await ctx.requestApproval({
            toolId: p.itemId as string,
            title: item?.changes ? `修改 ${item.changes.length} 个文件` : "修改文件",
            risk: "write",
            diffs: item?.changes?.map(toDiff),
            reason: (p.reason as string | undefined) ?? undefined,
            options: APPROVAL_OPTIONS,
          });
          return { decision: optionId ?? "cancel" };
        }
        case "execCommandApproval":
        case "applyPatchApproval":
          // Legacy v1 approvals: we only speak v2; deny explicitly rather than hang.
          return { decision: { denied: { rejection: "AgentFleet only supports v2 approvals" } } };
        default:
          ctx.log("warn", `[codex] unsupported server request: ${method}`);
          throw new JsonRpcError(-32601, `AgentFleet does not handle ${method}`);
      }
    };

    const fail = async (msg: string): Promise<never> => {
      peer.dispose(new Error(msg));
      await killTree(child);
      throw new Error(msg);
    };
    const race = <T>(p: Promise<T>) => Promise.race([p, exited.then((m) => Promise.reject(new Error(m)))]);

    try {
      await race(
        peer.request("initialize", {
          clientInfo: { name: "agentfleet", title: "AgentFleet", version: "0.1.0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        }),
      );
      peer.notify("initialized");
      const started = await race(
        peer.request<{ thread: { id: string }; model?: string }>("thread/start", {
          cwd: ctx.cwd,
          approvalPolicy: "on-request",
          sandbox: this.def.sandbox ?? "workspace-write",
          model: spec.model ?? null,
          developerInstructions: spec.instructions ?? null,
        }),
      );
      threadId = started.thread.id;
      ctx.log("info", `[codex] thread ${threadId} started${started.model ? ` (model ${started.model})` : ""}`);
    } catch (err) {
      return fail(`codex startup failed: ${(err as Error).message}`);
    }

    return {
      prompt: async (text: string): Promise<TurnResult> => {
        try {
          const res = await race(
            peer.request<{ turn: { id: string } }>("turn/start", {
              threadId,
              input: [{ type: "text", text, text_elements: [] }],
            }),
          );
          currentTurn = res.turn.id;
          const early = earlyResults.get(res.turn.id);
          if (early) {
            earlyResults.delete(res.turn.id);
            return early;
          }
          const result = await race(
            new Promise<TurnResult>((resolve) => turnWaiters.set(res.turn.id, resolve)),
          );
          return result;
        } catch (err) {
          return { status: "failed", error: (err as Error).message };
        } finally {
          if (currentTurn) turnWaiters.delete(currentTurn);
          currentTurn = null;
        }
      },
      interrupt: async () => {
        if (currentTurn) await peer.request("turn/interrupt", { threadId, turnId: currentTurn }).catch(() => {});
      },
      close: async () => {
        peer.dispose(new Error("closed"));
        await killTree(child);
      },
    };
  }
}

/** Maps Codex app-server notifications to FleetEvents. Returns a turn result on `turn/completed`. */
export class CodexEventMapper {
  private items = new Map<string, ThreadItem>();
  private streamed = new Set<string>();
  constructor(private ctx: Pick<AdapterContext, "emit" | "log">) {}

  item(id: string) {
    return this.items.get(id);
  }

  map(method: string, p: Record<string, unknown>): { turnId: string; result: TurnResult } | void {
    const emit = (e: FleetEvent) => this.ctx.emit(e);
    switch (method) {
      case "item/agentMessage/delta":
        this.streamed.add(p.itemId as string);
        return emit({ type: "message.delta", role: "agent", text: p.delta as string });
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.streamed.add(p.itemId as string);
        return emit({ type: "reasoning.delta", text: p.delta as string });
      case "item/commandExecution/outputDelta":
        return emit({ type: "tool.updated", toolId: p.itemId as string, outputDelta: p.delta as string });
      case "item/started": {
        const item = p.item as ThreadItem;
        this.items.set(item.id, item);
        const tool = toolStart(item);
        if (tool) emit(tool);
        return;
      }
      case "item/completed": {
        const item = p.item as ThreadItem;
        this.items.set(item.id, item);
        if (item.type === "agentMessage" && !this.streamed.has(item.id) && item.text) {
          return emit({ type: "message.delta", role: "agent", text: item.text });
        }
        if (item.type === "reasoning" && !this.streamed.has(item.id) && item.summary?.length) {
          return emit({ type: "reasoning.delta", text: item.summary.join("\n") });
        }
        if (toolStart(item)) {
          emit({
            type: "tool.updated",
            toolId: item.id,
            status: item.status === "completed" ? "completed" : item.status === "inProgress" ? "in_progress" : "failed",
            exitCode: item.exitCode ?? undefined,
            output: item.aggregatedOutput ?? undefined,
            diffs: item.changes?.map(toDiff),
          });
        }
        return;
      }
      case "turn/plan/updated": {
        const plan = (p.plan as Array<{ step: string; status: string }>) ?? [];
        return emit({
          type: "plan.updated",
          entries: plan.map((s) => ({ content: s.step, status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending" })),
        });
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage as { total: Record<string, number>; last: Record<string, number>; modelContextWindow: number | null };
        return emit({
          type: "usage.updated",
          inputTokens: u.total.inputTokens,
          outputTokens: u.total.outputTokens,
          totalTokens: u.total.totalTokens,
          contextUsed: u.last.totalTokens,
          contextSize: u.modelContextWindow ?? undefined,
        });
      }
      case "error":
        return emit({ type: "log", level: "error", text: JSON.stringify(p).slice(0, 2000) });
      case "turn/completed": {
        const turn = p.turn as { id: string; status: string; error?: { message?: string } | null };
        const status = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : "failed";
        return { turnId: turn.id, result: { status, error: turn.error?.message } };
      }
      default:
        return;
    }
  }
}

function toolStart(item: ThreadItem): FleetEvent | null {
  switch (item.type) {
    case "commandExecution":
      return { type: "tool.started", toolId: item.id, title: item.command ?? "command", kind: "execute", input: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return {
        type: "tool.started",
        toolId: item.id,
        title: `编辑 ${item.changes?.map((c) => c.path).join(", ") ?? "文件"}`,
        kind: "edit",
      };
    case "mcpToolCall":
      return { type: "tool.started", toolId: item.id, title: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, kind: "other" };
    case "webSearch":
      return { type: "tool.started", toolId: item.id, title: `搜索: ${item.query ?? ""}`, kind: "fetch" };
    default:
      return null;
  }
}

function toDiff(c: { path: string; diff: string }): FileDiff {
  return { path: c.path, unified: c.diff };
}

/**
 * Returns a description of a non-ChatGPT credential source Codex will use, if any:
 * a custom top-level `model_provider` in $CODEX_HOME/config.toml, or OPENAI_API_KEY.
 */
export function customProvider(env: NodeJS.ProcessEnv): string | null {
  const home = env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    // Only top-level keys (before the first [table]) select the provider.
    const top = toml.split(/^\s*\[/m)[0] ?? "";
    const m = /^\s*model_provider\s*=\s*["']([^"']+)["']/m.exec(top);
    if (m && m[1] !== "openai") return m[1]!;
  } catch {
    // no config file
  }
  return env.OPENAI_API_KEY ? "OPENAI_API_KEY" : null;
}
