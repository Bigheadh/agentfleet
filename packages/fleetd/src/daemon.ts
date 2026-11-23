/** fleetd daemon: wires adapters + runner + hub connection together. */
import { platform, release } from "node:os";
import { join } from "node:path";
import { type Capability, type HubToNode, PROTOCOL_VERSION } from "@agentfleet/proto";
import type { AgentAdapter } from "./adapters/types.ts";
import { AGENTFLEET_HOME, type NodeConfig } from "./config.ts";
import { HubClient } from "./hubClient.ts";
import { buildAdapters, probeAll } from "./registry.ts";
import { Runner } from "./runner.ts";

export interface DaemonOptions {
  cfg: NodeConfig;
  /** Defaults to ~/.agentfleet/state/runs-<nodeId>.json */
  statePath?: string;
  /** Override adapters (tests). */
  adapters?: Map<string, AgentAdapter>;
  reprobeMs?: number;
  log?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
}

export interface Daemon {
  runner: Runner;
  client: HubClient;
  capabilities(): Capability[];
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { cfg } = opts;
  const log = opts.log ?? ((level, text) => (level === "debug" ? undefined : console.error(`[${level}] ${text}`)));
  const adapters = opts.adapters ?? buildAdapters(cfg);
  let caps = await probeAll(adapters);
  for (const c of caps) log("info", `agent ${c.id}: ${c.installed ? `✓ ${c.version ?? ""}` : "✗ 未安装"}${c.note ? ` (${c.note})` : ""}`);

  const projects = () => Object.keys(cfg.projects);
  let client!: HubClient;
  const runner = new Runner({
    cfg,
    adapters,
    send: (m) => client.send(m),
    statePath: opts.statePath ?? join(AGENTFLEET_HOME, "state", `runs-${cfg.nodeId}.json`),
    log,
  });

  const onMessage = (msg: HubToNode) => {
    switch (msg.type) {
      case "run.assign":
        void runner.assign(msg.spec);
        return;
      case "run.input":
        runner.input(msg.runId, msg.text);
        return;
      case "run.approval":
        runner.approval(msg.runId, msg.approvalId, msg.optionId);
        return;
      case "run.interrupt":
        void runner.interrupt(msg.runId);
        return;
      case "run.action":
        void runner.action(msg.runId, msg.action, msg.requestId);
        return;
    }
  };

  client = new HubClient({
    hubUrl: cfg.hub,
    token: cfg.token,
    log,
    onMessage,
    heartbeat: () => ({ type: "heartbeat", running: runner.running }),
    hello: (pending) => ({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      node: {
        id: cfg.nodeId,
        name: cfg.name,
        os: `${platform()} ${release()}`,
        labels: cfg.labels,
        maxConcurrency: cfg.maxConcurrency,
        runtimes: caps,
        projects: projects(),
      },
      activeRuns: [...new Set([...runner.activeRunIds(), ...pending])],
    }),
  });

  // Agents get installed / logged in while the daemon runs; refresh periodically.
  const reprobe = setInterval(async () => {
    caps = await probeAll(adapters);
    client.send({ type: "capabilities", runtimes: caps, projects: projects() });
  }, opts.reprobeMs ?? 10 * 60_000);
  reprobe.unref();

  await client.start();

  return {
    runner,
    client,
    capabilities: () => caps,
    async stop() {
      clearInterval(reprobe);
      await runner.shutdown();
      await client.stop();
    },
  };
}
