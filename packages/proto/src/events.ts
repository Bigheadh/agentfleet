/**
 * FleetEvent — the unified event model every adapter emits.
 *
 * Design rule (see design doc §4.5): FleetEvent is a superset of ACP's
 * `session/update` so the ACP adapter is a near pass-through, while native
 * adapters (Codex app-server, Claude stream-json, ...) map into it.
 */
import { z } from "zod";

/** Unified risk classes used by approval policies across all agents. */
export const Risk = z.enum(["read", "write", "exec", "danger"]);
export type Risk = z.infer<typeof Risk>;

/** Mirrors ACP ToolKind. */
export const ToolKind = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKind>;

/** Mirrors ACP ToolCallStatus. */
export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/** Mirrors ACP PermissionOptionKind. */
export const ApprovalOptionKind = z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]);
export type ApprovalOptionKind = z.infer<typeof ApprovalOptionKind>;

export const ApprovalOption = z.object({
  id: z.string(),
  label: z.string(),
  kind: ApprovalOptionKind,
});
export type ApprovalOption = z.infer<typeof ApprovalOption>;

export const FileDiff = z.object({
  path: z.string(),
  oldText: z.string().nullish(),
  newText: z.string().nullish(),
  /** Unified diff text when the agent provides one (e.g. Codex). */
  unified: z.string().nullish(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const PlanEntry = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof PlanEntry>;

export const RunStatus = z.enum([
  "starting",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const SealedBox = z.object({
  /** 24-byte random XChaCha20-Poly1305 nonce, base64. */
  n: z.string().min(1),
  /** Ciphertext + 16-byte Poly1305 tag, base64. */
  c: z.string().min(1),
});
export type SealedBox = z.infer<typeof SealedBox>;

export const EncryptedEventHint = z.enum(["approval.requested", "approval.resolved", "run.status", "other"]);
export type EncryptedEventHint = z.infer<typeof EncryptedEventHint>;

export const FleetEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.delta"), role: z.enum(["agent", "user"]), text: z.string() }),
  z.object({ type: z.literal("reasoning.delta"), text: z.string() }),
  z.object({ type: z.literal("plan.updated"), entries: z.array(PlanEntry) }),
  z.object({
    type: z.literal("tool.started"),
    toolId: z.string(),
    title: z.string(),
    kind: ToolKind,
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool.updated"),
    toolId: z.string(),
    status: ToolStatus.optional(),
    title: z.string().optional(),
    /** Incremental output (e.g. command stdout delta). */
    outputDelta: z.string().optional(),
    /** Full output; replaces anything accumulated so far (ACP sends whole content). */
    output: z.string().optional(),
    diffs: z.array(FileDiff).optional(),
    exitCode: z.number().nullish(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    approvalId: z.string(),
    toolId: z.string().optional(),
    title: z.string(),
    risk: Risk,
    command: z.string().optional(),
    cwd: z.string().optional(),
    diffs: z.array(FileDiff).optional(),
    reason: z.string().optional(),
    options: z.array(ApprovalOption),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    optionId: z.string().nullable(),
    /** "policy" = decided by the node-local policy.yaml without asking the phone. */
    by: z.enum(["user", "policy", "cancelled"]),
  }),
  z.object({
    type: z.literal("usage.updated"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    contextUsed: z.number().optional(),
    contextSize: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  /** Aggregated unified diff of the worktree vs. the base ref. */
  z.object({ type: z.literal("diff.updated"), unified: z.string(), files: z.number(), additions: z.number(), deletions: z.number() }),
  z.object({ type: z.literal("run.status"), status: RunStatus, detail: z.string().optional() }),
  z.object({ type: z.literal("log"), level: z.enum(["debug", "info", "warn", "error"]), text: z.string() }),
  /** End-to-end encrypted FleetEvent; hub sees only the minimal routing hint. */
  z.object({
    type: z.literal("encrypted"),
    hint: EncryptedEventHint.default("other"),
    status: RunStatus.optional(),
    box: SealedBox,
  }),
]);
export type FleetEvent = z.infer<typeof FleetEvent>;
export type FleetEventType = FleetEvent["type"];

/** Envelope persisted by the hub and streamed to clients. `seq` is per-run, monotonic. */
export const EventEnvelope = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  event: FleetEvent,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
