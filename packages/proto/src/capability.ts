/**
 * Runtime capabilities — declared by each adapter at probe time.
 * The scheduler filters on these and the app hides unsupported actions (design doc §4.3).
 */
import { z } from "zod";

export const Tier = z.enum(["native", "acp", "headless", "pty"]);
export type Tier = z.infer<typeof Tier>;

export const CapabilityFlag = z.enum([
  "interactiveApproval",
  "multiTurn",
  "resume",
  "fork",
  "usageReport",
  "structuredDiff",
  "mcpInjection",
  "images",
]);
export type CapabilityFlag = z.infer<typeof CapabilityFlag>;

export const Capability = z.object({
  /** Stable runtime id on the node, e.g. "codex", "acp:gemini", "acp:claude". */
  id: z.string(),
  /** Human-readable agent family, e.g. "Codex", "Gemini CLI". */
  agent: z.string(),
  tier: Tier,
  version: z.string().nullable(),
  installed: z.boolean(),
  loggedIn: z.boolean().nullable(),
  models: z.array(z.string()).default([]),
  supports: z.array(CapabilityFlag).default([]),
  /** Free-form diagnostic shown in the app when a runtime is unavailable. */
  note: z.string().optional(),
});
export type Capability = z.infer<typeof Capability>;

/** Higher is better; used as a scheduler score term. */
export const TIER_SCORE: Record<Tier, number> = { native: 1, acp: 0.75, headless: 0.4, pty: 0.1 };
