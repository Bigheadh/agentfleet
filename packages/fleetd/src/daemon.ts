/** fleetd daemon: wires adapters + runner + hub connection together. */
import { platform, release } from "node:os";
import { join } from "node:path";
import { type Capability, type HubToNode, keyFingerprint, type KeyPair, PROTOCOL_VERSION } from "@agentfleet/proto";
import type { AgentAdapter } from "./adapters/types.ts";
import { AGENTFLEET_HOME, type NodeConfig } from "./config.ts";
import { HubClient } from "./hubClient.ts";
import { defaultIdentityPath, loadOrCreateIdentity } from "./identity.ts";
import { buildAdapters, probeAll } from "./registry.ts";
import { Runner } from "./runner.ts";

export interface DaemonOptions {
  cfg: NodeConfig;
  /** Defaults to ~/.agentfleet/state/runs-<nodeId>.json */
  statePath?: string;
  /** Override node E2EE keypair path (defaults to cfg.e2ee.keyPath or ~/.agentfleet/state/identity-<nodeId>.key). */
  identityPath?: string;
  /** Override node E2EE keypair directly (tests). */
  identity?: KeyPair;
  /** Override adapters (tests). */
  adapters?: Map<string, AgentAdapter>;
  reprobeMs?: number;
  log?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
}

export interface Daemon {
  runner: Runner;
  client: HubClient;
  publicKey: string;
  capabilities(): Capability[];
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { cfg } = opts;
  const log = opts.log ?? ((level, text) => (level === "debug" ? undefined : console.error(`[${level}] ${text}`)));
  const identity = opts.identity ?? loadOrCreateIdentity(opts.identityPath ?? cfg.e2ee.keyPath ?? defaultIdentityPath(cfg.nodeId));
  log(
    "info",
    `E2EE 公钥指纹: ${keyFingerprint(identity.publicKey)}（模式: ${cfg.e2ee.mode === "required" ? "强制加密" : "自动支持"}）`,
  );
  const adapters = opts.adapters ?? buildAdapters(cfg);
  let caps = await probeAll(adapters);
  for (const c of caps) log("info", `agent ${c.id}: ${c.installed ? `✓${c.version ? ` ${c.version}` : ""}` : "✗ 未安装"}${c.note ? ` (${c.note})` : ""}`);

  const projects = () => Object.keys(cfg.projects);
  let client!: HubClient;
  const runner = new Runner({
    cfg,
    adapters,
    send: (m) => client.send(m),
    statePath: opts.statePath ?? join(AGENTFLEET_HOME, "state", `runs-${cfg.nodeId}.json`),
    identity,
    log,
  });

  const onMessage = (msg: HubToNode) => {
    switch (msg.type) {
      case "run.assign":
        void runner.assign(msg.spec);
        return;
      case "run.input":
        runner.input(msg.runId, msg.text, msg.e2ee);
        return;
      case "run.approval":
        runner.approval(msg.runId, msg.approvalId, msg.optionId, msg.e2ee);
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
        publicKey: identity.publicKey,
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
    publicKey: identity.publicKey,
    capabilities: () => caps,
    async stop() {
      clearInterval(reprobe);
      await runner.shutdown();
      await client.stop();
    },
  };
}
