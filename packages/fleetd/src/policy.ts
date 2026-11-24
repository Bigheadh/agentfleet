/** Node-local approval policy — the final authority (design doc §7). */
import { type ApprovalOption, Risk } from "@agentfleet/proto";
import { z } from "zod";
import type { ApprovalRequest } from "./adapters/types.ts";

export const Decision = z.enum(["allow", "ask", "deny"]);
export type Decision = z.infer<typeof Decision>;

export const DEFAULT_DANGER_PATTERNS = [
  String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(/|~|\$HOME)(\s|$)`,
  String.raw`\brm\s+-[a-zA-Z]*f[a-zA-Z]*r`,
  String.raw`\bgit\s+push\b.*(--force|-f\b)`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b`,
  String.raw`\bsudo\b`,
  String.raw`\bmkfs\b|\bdd\s+if=`,
  String.raw`\bchmod\s+-R\s+777\b`,
];

export const PolicyConfig = z.object({
  defaults: z
    .object({
      read: Decision.default("allow"),
      write: Decision.default("ask"),
      exec: Decision.default("ask"),
      danger: Decision.default("ask"),
    })
    .prefault({}),
  /** First match wins. `command` is a regex tested against the command line. */
  rules: z
    .array(z.object({ command: z.string().optional(), risk: Risk.optional(), decision: Decision }))
    .default([]),
  dangerPatterns: z.array(z.string()).default(DEFAULT_DANGER_PATTERNS),
  /** Unanswered approvals are cancelled after this long. */
  approvalTimeoutMinutes: z.number().positive().default(60),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export interface PolicyVerdict {
  risk: Risk;
  decision: Decision;
  rule?: string;
}

export class Policy {
  private danger: RegExp[];
  private rules: Array<{ re?: RegExp; risk?: Risk; decision: Decision; src: string }>;

  constructor(readonly config: PolicyConfig) {
    this.danger = config.dangerPatterns.map((p) => new RegExp(p, "i"));
    this.rules = config.rules.map((r) => ({
      re: r.command ? new RegExp(r.command) : undefined,
      risk: r.risk,
      decision: r.decision,
      src: JSON.stringify(r),
    }));
  }

  evaluate(req: Pick<ApprovalRequest, "risk" | "command">): PolicyVerdict {
    const cmd = req.command ?? "";
    // Escalate: a command matching a danger pattern is "danger" no matter what the agent said.
    const risk: Risk = cmd && this.danger.some((re) => re.test(cmd)) ? "danger" : req.risk;
    for (const r of this.rules) {
      if (r.risk && r.risk !== risk) continue;
      if (r.re && !(cmd && r.re.test(cmd))) continue;
      if (!r.re && !r.risk) continue;
      // Never let a rule silently auto-allow something classified as danger.
      if (risk === "danger" && r.decision === "allow") continue;
      return { risk, decision: r.decision, rule: r.src };
    }
    const def = this.config.defaults[risk];
    return { risk, decision: risk === "danger" && def === "allow" ? "ask" : def };
  }
}

/** Picks the option that implements an automatic allow/deny decision. */
export function optionFor(decision: "allow" | "deny", options: ApprovalOption[]): string | null {
  const prefs = decision === "allow" ? (["allow_once", "allow_always"] as const) : (["reject_once", "reject_always"] as const);
  for (const k of prefs) {
    const o = options.find((x) => x.kind === k);
    if (o) return o.id;
  }
  return null;
}
