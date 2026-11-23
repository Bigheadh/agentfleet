/** Core domain models shared by hub, node daemon and clients. */
import { z } from "zod";
import { Capability, CapabilityFlag } from "./capability.ts";
import { RunStatus } from "./events.ts";

export const NodeInfo = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string(),
  labels: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().positive(),
  running: z.number().int().nonnegative(),
  online: z.boolean(),
  lastSeen: z.number(),
  runtimes: z.array(Capability),
  /** Project ids this node has a local checkout for. */
  projects: z.array(z.string()).default([]),
});
export type NodeInfo = z.infer<typeof NodeInfo>;

export const TaskState = z.enum([
  "queued",
  "assigned",
  "running",
  "waiting_approval",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

export const Priority = z.enum(["low", "normal", "high"]);
export type Priority = z.infer<typeof Priority>;

export const TaskConstraints = z.object({
  /** "any", a runtime id ("codex", "acp:gemini") or a list of acceptable runtime ids. */
  agent: z.union([z.string(), z.array(z.string())]).default("any"),
  requires: z.array(CapabilityFlag).default([]),
  labels: z.array(z.string()).default([]),
  /** Pin to a specific node. */
  nodeId: z.string().optional(),
  model: z.string().optional(),
});
export type TaskConstraints = z.infer<typeof TaskConstraints>;

export const Task = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  prompt: z.string(),
  priority: Priority,
  constraints: TaskConstraints,
  state: TaskState,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Latest run id, if any. */
  runId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  /** Scheduler/hub explanation, e.g. why the task is still queued. */
  note: z.string().nullish(),
});
export type Task = z.infer<typeof Task>;

export const Run = z.object({
  id: z.string(),
  taskId: z.string(),
  nodeId: z.string(),
  runtimeId: z.string(),
  status: RunStatus,
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  lastSeq: z.number().int(),
  pendingApprovals: z.number().int().nonnegative(),
});
export type Run = z.infer<typeof Run>;

/** What the node needs to start a run. */
export const RunSpec = z.object({
  runId: z.string(),
  taskId: z.string(),
  project: z.string(),
  runtimeId: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  instructions: z.string().optional(),
});
export type RunSpec = z.infer<typeof RunSpec>;

/** Post-run actions the user can trigger from the phone. */
export const RunAction = z.enum(["commit", "push", "pr", "discard"]);
export type RunAction = z.infer<typeof RunAction>;
