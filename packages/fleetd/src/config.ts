/** Node configuration (`~/.agentfleet/node.yaml`). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PolicyConfig } from "./policy.ts";

export const AGENTFLEET_HOME = process.env.AGENTFLEET_HOME ?? join(homedir(), ".agentfleet");
export const DEFAULT_CONFIG_PATH = process.env.AGENTFLEET_NODE_CONFIG ?? join(AGENTFLEET_HOME, "node.yaml");

export const AgentOverride = z.object({
  enabled: z.boolean().default(true),
  /** Display name for custom agents. */
  agent: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Custom ACP agents: extra CLI that must exist (e.g. "claude"). */
  requires: z.string().optional(),
  versionArgs: z.array(z.string()).optional(),
  /** Codex only. */
  probeLogin: z.boolean().optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
});
export type AgentOverride = z.infer<typeof AgentOverride>;

export const ProjectConfig = z.object({
  path: z.string(),
  /** Base ref for new worktrees; defaults to the repo's current HEAD. */
  baseRef: z.string().optional(),
});

export const NodeConfig = z.object({
  hub: z.string().url(),
  nodeId: z.string(),
  token: z.string(),
  name: z.string(),
  labels: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().positive().default(2),
  workRoot: z.string().default(join(AGENTFLEET_HOME, "worktrees")),
  projects: z.record(z.string(), ProjectConfig).default({}),
  agents: z.record(z.string(), AgentOverride).default({}),
  policy: PolicyConfig.prefault({}),
  /** Keep an agent session alive this long after a turn for follow-up prompts. */
  idleSessionMinutes: z.number().positive().default(30),
});
export type NodeConfig = z.infer<typeof NodeConfig>;

export function loadConfig(path = DEFAULT_CONFIG_PATH): NodeConfig {
  if (!existsSync(path)) throw new Error(`配置文件不存在: ${path}\n先运行: agentfleet-node join <HUB_URL> <JOIN_TOKEN>`);
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
  const cfg = NodeConfig.parse(raw);
  for (const p of Object.values(cfg.projects)) p.path = resolve(expandHome(p.path));
  cfg.workRoot = resolve(expandHome(cfg.workRoot));
  return cfg;
}

export function saveConfig(cfg: NodeConfig, path = DEFAULT_CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(cfg), { mode: 0o600 });
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}
