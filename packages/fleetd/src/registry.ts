/**
 * Built-in agent registry + config overrides.
 *
 * Adding an ACP agent needs no code: add it under `agents:` in node.yaml with an
 * id starting with "acp:" and its command line.
 */
import type { Capability } from "@agentfleet/proto";
import { AcpAdapter, type AcpAgentDef } from "./adapters/acp.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import type { AgentAdapter } from "./adapters/types.ts";
import type { AgentOverride, NodeConfig } from "./config.ts";

export const BUILTIN_ACP_AGENTS: AcpAgentDef[] = [
  {
    id: "acp:gemini",
    agent: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    versionCommand: { command: "gemini", args: ["--version"] },
  },
  {
    // npm i -g @zed-industries/claude-agent-acp — bundles Claude Code via the Agent SDK,
    // so a separate `claude` binary is NOT required. Auth: `claude /login` once, or
    // ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL for gateways).
    // No version flag: the bridge reports its version in the ACP initialize response.
    id: "acp:claude",
    agent: "Claude Code",
    command: "claude-agent-acp",
    args: [],
  },
  {
    // npm i -g @zed-industries/codex-acp  — fallback when the native app-server adapter breaks
    id: "acp:codex",
    agent: "Codex (ACP)",
    command: "codex-acp",
    args: [],
  },
];

export function buildAdapters(cfg: Pick<NodeConfig, "agents">): Map<string, AgentAdapter> {
  const out = new Map<string, AgentAdapter>();
  const ov = (id: string): AgentOverride | undefined => cfg.agents[id];

  const codex = ov("codex");
  if (codex?.enabled !== false) {
    out.set(
      "codex",
      new CodexAdapter({
        command: codex?.command ?? "codex",
        args: codex?.args ?? ["app-server"],
        env: codex?.env,
        probeLogin: codex?.probeLogin,
        sandbox: codex?.sandbox,
      }),
    );
  }

  for (const def of BUILTIN_ACP_AGENTS) {
    const o = ov(def.id);
    if (o?.enabled === false) continue;
    out.set(def.id, new AcpAdapter(mergeAcp(def, o)));
  }

  for (const [id, o] of Object.entries(cfg.agents)) {
    if (out.has(id) || o.enabled === false || id === "codex") continue;
    if (!id.startsWith("acp:")) throw new Error(`未知 agent "${id}"：自定义 agent 的 id 需以 "acp:" 开头`);
    if (!o.command) throw new Error(`agent "${id}" 缺少 command`);
    out.set(id, new AcpAdapter(mergeAcp({ id, agent: o.agent ?? id.slice(4), command: o.command, args: [] }, o)));
  }
  return out;
}

function mergeAcp(def: AcpAgentDef, o: AgentOverride | undefined): AcpAgentDef {
  if (!o) return def;
  return {
    ...def,
    agent: o.agent ?? def.agent,
    command: o.command ?? def.command,
    args: o.args ?? def.args,
    env: { ...def.env, ...o.env },
    requires: o.requires ?? def.requires,
    versionCommand: o.versionArgs ? { command: o.command ?? def.command, args: o.versionArgs } : def.versionCommand,
  };
}

export async function probeAll(adapters: Map<string, AgentAdapter>): Promise<Capability[]> {
  return Promise.all(
    [...adapters.values()].map((a) =>
      a.probe().catch(
        (err): Capability => ({
          id: a.id,
          agent: a.id,
          tier: a.id.startsWith("acp:") ? "acp" : "native",
          version: null,
          installed: false,
          loggedIn: null,
          models: [],
          supports: [],
          note: `probe failed: ${(err as Error).message}`,
        }),
      ),
    ),
  );
}
