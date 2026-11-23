/**
 * Adapter contract (design doc §4.4). Every agent integration — native protocol,
 * ACP, headless CLI or PTY — implements this and nothing else.
 *
 * Adapters never talk to the hub and never decide approvals themselves: they
 * call `ctx.requestApproval(...)`, and the runner applies the node-local policy
 * first (policy is the final authority), only forwarding "ask" decisions to the phone.
 */
import type { ApprovalOption, Capability, FileDiff, FleetEvent, Risk, RunSpec } from "@agentfleet/proto";

export interface ApprovalRequest {
  toolId?: string;
  title: string;
  /** Adapter's best guess; the policy may escalate it (e.g. exec -> danger). */
  risk: Risk;
  command?: string;
  cwd?: string;
  diffs?: FileDiff[];
  reason?: string;
  options: ApprovalOption[];
}

export interface AdapterContext {
  /** Absolute path of the run's git worktree. */
  cwd: string;
  emit(event: FleetEvent): void;
  /** Resolves with the chosen option id, or null if cancelled. */
  requestApproval(req: ApprovalRequest): Promise<string | null>;
  log(level: "debug" | "info" | "warn" | "error", text: string): void;
}

export interface TurnResult {
  status: "completed" | "failed" | "interrupted";
  error?: string;
}

/** A live agent session (one per run). Turns are sequential. */
export interface AgentSession {
  prompt(text: string): Promise<TurnResult>;
  /** Cancels the in-flight turn, if any. */
  interrupt(): Promise<void>;
  /** Terminates the agent process. */
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: string;
  probe(): Promise<Capability>;
  start(spec: RunSpec, ctx: AdapterContext): Promise<AgentSession>;
}

/** Common definition for spawning an agent process. */
export interface AgentCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
