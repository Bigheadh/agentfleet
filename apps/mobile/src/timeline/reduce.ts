/**
 * Pure reducer that folds a run's EventEnvelope stream into renderable timeline
 * items. No React / React Native imports here so it can be unit-tested in Node.
 *
 * Rules:
 * - Envelopes with `seq <= lastSeq` are ignored (dedupe between the REST
 *   backfill and the live WS stream, and across reconnects).
 * - Consecutive `message.delta` events of the same role are coalesced into one
 *   chat bubble; consecutive `reasoning.delta` into one reasoning block. Events
 *   that do not create a timeline item (tool.updated, usage, plan, diff,
 *   approval.resolved) do not break coalescing.
 * - `plan.updated`, `usage.updated` and `diff.updated` are "latest value" state
 *   kept outside the item list (rendered as sticky panels / tabs).
 */
import type {
  ApprovalOption,
  EventEnvelope,
  FileDiff,
  PlanEntry,
  Risk,
  RunStatus,
  ToolKind,
  ToolStatus,
} from "@agentfleet/proto";

export interface MessageItem {
  kind: "message";
  id: string;
  role: "agent" | "user";
  text: string;
  ts: number;
}

export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  text: string;
  ts: number;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  toolId: string;
  title: string;
  toolKind: ToolKind;
  status: ToolStatus;
  input?: unknown;
  output: string;
  diffs: FileDiff[];
  exitCode: number | null;
  ts: number;
}

export interface ApprovalResolution {
  optionId: string | null;
  by: "user" | "policy" | "cancelled";
}

export interface ApprovalItem {
  kind: "approval";
  id: string;
  approvalId: string;
  toolId?: string;
  title: string;
  risk: Risk;
  command?: string;
  cwd?: string;
  diffs: FileDiff[];
  reason?: string;
  options: ApprovalOption[];
  resolution: ApprovalResolution | null;
  ts: number;
}

export interface StatusItem {
  kind: "status";
  id: string;
  status: RunStatus;
  detail?: string;
  ts: number;
}

export interface LogItem {
  kind: "log";
  id: string;
  level: "debug" | "info" | "warn" | "error";
  text: string;
  ts: number;
}

export type TimelineItem = MessageItem | ReasoningItem | ToolItem | ApprovalItem | StatusItem | LogItem;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
}

export interface AggregateDiff {
  unified: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface TimelineState {
  items: TimelineItem[];
  /** Highest seq applied so far; -1 when empty. Use as `after` for the next fetch/subscribe. */
  lastSeq: number;
  plan: PlanEntry[] | null;
  usage: Usage | null;
  diff: AggregateDiff | null;
  /** Latest run.status seen in the stream. */
  status: RunStatus | null;
}

export const emptyTimeline: TimelineState = Object.freeze({
  items: [],
  lastSeq: -1,
  plan: null,
  usage: null,
  diff: null,
  status: null,
}) as TimelineState;

/**
 * Apply a batch of envelopes. Returns the same object if nothing changed,
 * otherwise a new state (items array and touched items are copied, so the
 * result is safe to use as React state).
 */
export function applyEvents(state: TimelineState, envelopes: readonly EventEnvelope[]): TimelineState {
  const fresh = envelopes.filter((e) => e.seq > state.lastSeq);
  if (fresh.length === 0) return state;
  // Out-of-order delivery is not expected, but sorting is cheap and keeps the
  // reducer deterministic.
  fresh.sort((a, b) => a.seq - b.seq);

  const items = state.items.slice();
  const copied = new Set<number>();
  let { plan, usage, diff, status, lastSeq } = state;

  /** Copy-on-write access to an existing item. */
  const mutable = <T extends TimelineItem>(index: number): T => {
    if (!copied.has(index)) {
      items[index] = { ...items[index]! } as TimelineItem;
      copied.add(index);
    }
    return items[index] as T;
  };
  const push = (item: TimelineItem) => {
    items.push(item);
    copied.add(items.length - 1);
  };
  const findLast = (pred: (item: TimelineItem) => boolean): number => {
    for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
    return -1;
  };

  for (const env of fresh) {
    if (env.seq <= lastSeq) continue; // duplicate seq inside the batch
    lastSeq = env.seq;
    const ev = env.event;
    const id = `${env.runId}:${env.seq}`;
    const last = items[items.length - 1];

    switch (ev.type) {
      case "message.delta": {
        if (last && last.kind === "message" && last.role === ev.role) {
          const m = mutable<MessageItem>(items.length - 1);
          m.text += ev.text;
        } else {
          push({ kind: "message", id, role: ev.role, text: ev.text, ts: env.ts });
        }
        break;
      }
      case "reasoning.delta": {
        if (last && last.kind === "reasoning") {
          const r = mutable<ReasoningItem>(items.length - 1);
          r.text += ev.text;
        } else {
          push({ kind: "reasoning", id, text: ev.text, ts: env.ts });
        }
        break;
      }
      case "plan.updated":
        plan = ev.entries;
        break;
      case "tool.started": {
        const idx = findLast((it) => it.kind === "tool" && it.toolId === ev.toolId);
        if (idx >= 0) {
          // Re-announced tool (e.g. adapter replay): refresh metadata in place.
          const t = mutable<ToolItem>(idx);
          t.title = ev.title;
          t.toolKind = ev.kind;
          if (ev.input !== undefined) t.input = ev.input;
        } else {
          push({
            kind: "tool",
            id,
            toolId: ev.toolId,
            title: ev.title,
            toolKind: ev.kind,
            status: "pending",
            input: ev.input,
            output: "",
            diffs: [],
            exitCode: null,
            ts: env.ts,
          });
        }
        break;
      }
      case "tool.updated": {
        let idx = findLast((it) => it.kind === "tool" && it.toolId === ev.toolId);
        if (idx < 0) {
          push({
            kind: "tool",
            id,
            toolId: ev.toolId,
            title: ev.title ?? ev.toolId,
            toolKind: "other",
            status: "pending",
            output: "",
            diffs: [],
            exitCode: null,
            ts: env.ts,
          });
          idx = items.length - 1;
        }
        const t = mutable<ToolItem>(idx);
        if (ev.status) t.status = ev.status;
        if (ev.title) t.title = ev.title;
        // `output` replaces (ACP sends full content), `outputDelta` appends (Codex).
        if (ev.output !== undefined) t.output = ev.output;
        if (ev.outputDelta) t.output += ev.outputDelta;
        if (ev.diffs) t.diffs = ev.diffs;
        if (ev.exitCode !== undefined) t.exitCode = ev.exitCode;
        break;
      }
      case "approval.requested": {
        const idx = findLast((it) => it.kind === "approval" && it.approvalId === ev.approvalId);
        if (idx >= 0) break; // already shown
        push({
          kind: "approval",
          id,
          approvalId: ev.approvalId,
          toolId: ev.toolId,
          title: ev.title,
          risk: ev.risk,
          command: ev.command,
          cwd: ev.cwd,
          diffs: ev.diffs ?? [],
          reason: ev.reason,
          options: ev.options,
          resolution: null,
          ts: env.ts,
        });
        break;
      }
      case "approval.resolved": {
        const idx = findLast((it) => it.kind === "approval" && it.approvalId === ev.approvalId);
        if (idx >= 0) {
          const a = mutable<ApprovalItem>(idx);
          a.resolution = { optionId: ev.optionId, by: ev.by };
        }
        break;
      }
      case "usage.updated": {
        const { type: _type, ...rest } = ev;
        usage = { ...(usage ?? {}), ...stripUndefined(rest) };
        break;
      }
      case "diff.updated":
        diff = { unified: ev.unified, files: ev.files, additions: ev.additions, deletions: ev.deletions };
        break;
      case "run.status":
        status = ev.status;
        push({ kind: "status", id, status: ev.status, detail: ev.detail, ts: env.ts });
        break;
      case "log":
        push({ kind: "log", id, level: ev.level, text: ev.text, ts: env.ts });
        break;
      case "encrypted":
        push({ kind: "log", id, level: "warn", text: "端到端加密事件尚未解密", ts: env.ts });
        break;
      default: {
        // Exhaustiveness guard: new FleetEvent types are ignored at runtime.
        const _never: never = ev;
        void _never;
      }
    }
  }

  return { items, lastSeq, plan, usage, diff, status };
}

/** Convenience: build a timeline from scratch. */
export function buildTimeline(envelopes: readonly EventEnvelope[]): TimelineState {
  return applyEvents(emptyTimeline, envelopes);
}

/** Approvals still waiting for a decision. */
export function pendingApprovals(state: TimelineState): ApprovalItem[] {
  return state.items.filter((it): it is ApprovalItem => it.kind === "approval" && it.resolution === null);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
