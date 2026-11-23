/**
 * L2 — generic ACP (Agent Client Protocol) adapter.
 *
 * One implementation covers every ACP agent: Gemini CLI (`gemini --acp`),
 * Claude Code via `claude-agent-acp`, Codex via `codex-acp`, Goose, Kiro, ...
 * FleetEvent is a superset of ACP `session/update`, so mapping is mostly 1:1.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Capability, FileDiff, FleetEvent, Risk, RunSpec } from "@agentfleet/proto";
import { classifyStderr, commandExists, killTree, spawnAgent, versionOf } from "../proc.ts";
import type { AdapterContext, AgentAdapter, AgentCommand, AgentSession, TurnResult } from "./types.ts";

export interface AcpAgentDef extends AgentCommand {
  /** Runtime id, must start with "acp:". */
  id: string;
  agent: string;
  /** Command used to read a version string; omit to skip. */
  versionCommand?: AgentCommand;
  /** Underlying CLI that must be installed (e.g. `claude` for claude-agent-acp). */
  requires?: string;
}

const CLIENT_INFO = { name: "agentfleet", title: "AgentFleet", version: "0.1.0" };
const SESSION_START_TIMEOUT_MS = Number(process.env.AGENTFLEET_ACP_SESSION_TIMEOUT_MS ?? 120_000);

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  constructor(private def: AcpAgentDef) {
    this.id = def.id;
  }

  async probe(): Promise<Capability> {
    const installed = (await commandExists(this.def.command)) && (!this.def.requires || (await commandExists(this.def.requires)));
    const v = installed && this.def.versionCommand ? await versionOf(this.def.versionCommand.command, this.def.versionCommand.args) : null;
    return {
      id: this.id,
      agent: this.def.agent,
      tier: "acp",
      version: v,
      installed,
      // ACP has no standard "am I logged in" probe; auth errors surface at session/new.
      loggedIn: null,
      models: [],
      supports: ["interactiveApproval", "multiTurn", "structuredDiff", "mcpInjection"],
      note: installed ? undefined : `未找到命令: ${this.def.requires ?? this.def.command}`,
    };
  }

  async start(spec: RunSpec, ctx: AdapterContext): Promise<AgentSession> {
    const child = spawnAgent(this.def.command, this.def.args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...this.def.env },
      onStderr: (line) => {
        const { level, text } = classifyStderr(line);
        ctx.log(level, `[${this.id}] ${text}`);
      },
    });
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code, sig) => resolve(`agent process exited (code=${code}, signal=${sig})`));
      child.once("error", (err) => resolve(`failed to start agent: ${err.message}`));
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const mapper = new AcpEventMapper(ctx);
    const app = acp
      .client({ name: "agentfleet" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const tc = params.toolCall;
        const optionId = await ctx.requestApproval({
          toolId: tc.toolCallId,
          title: tc.title ?? mapper.titleOf(tc.toolCallId) ?? "工具调用",
          risk: riskOf(tc.kind ?? mapper.kindOf(tc.toolCallId)),
          command: commandOf(tc.rawInput),
          diffs: diffsOf(tc.content, ctx.cwd),
          options: params.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
        });
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => mapper.map(params.update));

    const conn = app.connect(stream);
    const fail = async (msg: string): Promise<never> => {
      conn.close();
      await killTree(child);
      throw new Error(msg);
    };

    // SDK typings resolve `initialize` params to `never` (TS 7); use the explicitly-typed overload.
    const initReq = conn.agent.request<acp.InitializeResponse, acp.InitializeRequest>(acp.methods.agent.initialize as string, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: CLIENT_INFO,
    });
    const init: Awaited<typeof initReq> = await Promise.race([initReq, exited.then((m) => fail(m))]).catch((e) =>
      fail(`ACP initialize failed: ${(e as Error).message}`),
    );
    ctx.log("info", `[${this.id}] connected: ${init.agentInfo?.name ?? this.def.agent} ${init.agentInfo?.version ?? ""}`.trim());

    const sessReq = conn.agent.request(acp.methods.agent.session.new, { cwd: ctx.cwd, mcpServers: [] });
    const session: Awaited<typeof sessReq> = await Promise.race([
      sessReq,
      exited.then((m) => Promise.reject(new Error(m))),
      rejectAfter(SESSION_START_TIMEOUT_MS, `session/new 超过 ${SESSION_START_TIMEOUT_MS / 1000}s 未响应`),
    ]).catch((e) => fail(authHint(e as Error, init.authMethods?.map((m) => m.name) ?? [])));
    const sessionId = session.sessionId;
    const modelOpt = session.configOptions?.find((o) => o.category === "model" || o.id === "model");
    if (spec.model) {
      if (!modelOpt) ctx.log("warn", `[${this.id}] agent 不支持选择模型，忽略 model=${spec.model}`);
      else {
        await conn.agent
          .request(acp.methods.agent.session.setConfigOption, { sessionId, configId: modelOpt.id, value: spec.model })
          .then(() => ctx.log("info", `[${this.id}] model = ${spec.model}`))
          .catch((e) => ctx.log("warn", `[${this.id}] 设置模型 ${spec.model} 失败: ${(e as Error).message}`));
      }
    } else if (modelOpt && modelOpt.type === "select") {
      ctx.log("info", `[${this.id}] model = ${modelOpt.currentValue}`);
    }
    let inTurn = false;

    return {
      prompt: async (text: string): Promise<TurnResult> => {
        inTurn = true;
        try {
          const res = await Promise.race([
            conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
            exited.then((m) => {
              throw new Error(m);
            }),
          ]);
          mapper.flush();
          if (res.stopReason === "cancelled") return { status: "interrupted" };
          if (res.stopReason === "refusal") return { status: "failed", error: "agent refused the request" };
          return { status: "completed" };
        } catch (err) {
          return { status: "failed", error: (err as Error).message };
        } finally {
          inTurn = false;
        }
      },
      interrupt: async () => {
        if (inTurn) await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
      },
      close: async () => {
        conn.close();
        await killTree(child);
      },
    };
  }
}

/** Maps ACP session updates to FleetEvents, keeping per-tool state for titles/kinds. */
export class AcpEventMapper {
  private tools = new Map<string, { title: string; kind: acp.ToolKind }>();
  constructor(private ctx: Pick<AdapterContext, "emit"> & { cwd?: string }) {}

  titleOf(id: string) {
    return this.tools.get(id)?.title;
  }
  kindOf(id: string) {
    return this.tools.get(id)?.kind;
  }
  flush() {}

  map(u: acp.SessionUpdate) {
    const emit = (e: FleetEvent) => this.ctx.emit(e);
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") emit({ type: "message.delta", role: "agent", text: u.content.text });
        return;
      case "agent_thought_chunk":
        if (u.content.type === "text") emit({ type: "reasoning.delta", text: u.content.text });
        return;
      case "tool_call": {
        const kind = u.kind ?? "other";
        this.tools.set(u.toolCallId, { title: u.title, kind });
        emit({ type: "tool.started", toolId: u.toolCallId, title: u.title, kind, input: u.rawInput });
        const output = textOf(u.content);
        const diffs = diffsOf(u.content, this.ctx.cwd);
        if (output || diffs || (u.status && u.status !== "pending")) {
          emit({ type: "tool.updated", toolId: u.toolCallId, status: u.status, output, diffs });
        }
        return;
      }
      case "tool_call_update": {
        const prev = this.tools.get(u.toolCallId);
        if (prev && (u.title || u.kind)) this.tools.set(u.toolCallId, { title: u.title ?? prev.title, kind: u.kind ?? prev.kind });
        emit({
          type: "tool.updated",
          toolId: u.toolCallId,
          status: u.status ?? undefined,
          title: u.title ?? undefined,
          output: textOf(u.content ?? undefined),
          diffs: diffsOf(u.content ?? undefined, this.ctx.cwd),
        });
        return;
      }
      case "plan":
        emit({ type: "plan.updated", entries: u.entries.map((e) => ({ content: e.content, status: e.status })) });
        return;
      case "usage_update":
        emit({
          type: "usage.updated",
          contextUsed: u.used,
          contextSize: u.size,
          costUsd: u.cost && u.cost.currency.toUpperCase() === "USD" ? u.cost.amount : undefined,
        });
        return;
      default:
        return;
    }
  }
}

type ToolContent = acp.ToolCallContent[] | undefined;

function textOf(content: ToolContent): string | undefined {
  if (!content?.length) return undefined;
  const parts = content.flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []));
  return parts.length ? parts.join("\n") : undefined;
}

/** Extracts diffs; paths inside `cwd` are made relative (agents like Gemini send absolute worktree paths). */
export function diffsOf(content: ToolContent | null, cwd?: string): FileDiff[] | undefined {
  if (!content?.length) return undefined;
  const rel = (p: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
  const diffs = content.flatMap((c) => (c.type === "diff" ? [{ path: rel(c.path), oldText: c.oldText ?? null, newText: c.newText }] : []));
  return diffs.length ? diffs : undefined;
}

export function riskOf(kind: acp.ToolKind | null | undefined): Risk {
  switch (kind) {
    case "read":
    case "search":
    case "think":
    case "fetch":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "write";
    default:
      return "exec";
  }
}

export function commandOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const c = r.command ?? r.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return undefined;
}

function authHint(err: Error, methods: string[]): string {
  const msg = err.message;
  if (/auth/i.test(msg) || (err as { code?: number }).code === -32000) {
    return `agent 需要登录${methods.length ? `（支持: ${methods.join(", ")}）` : ""}，请在节点上先完成登录: ${msg}`;
  }
  return `ACP session/new failed: ${msg}`;
}
