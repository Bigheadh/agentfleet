#!/usr/bin/env node
/**
 * agentfleet-node CLI
 *
 *   agentfleet-node join <HUB_URL> <JOIN_TOKEN> [--name NAME] [--label L]... [--max-concurrency N]
 *   agentfleet-node project add <NAME> <PATH> [--base REF]
 *   agentfleet-node project list | project remove <NAME>
 *   agentfleet-node probe          # which agents are installed / logged in
 *   agentfleet-node policy         # effective approval policy
 *   agentfleet-node start          # run the daemon
 *
 * Global: --config <path>  (default ~/.agentfleet/node.yaml, env AGENTFLEET_NODE_CONFIG)
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isValidPublicKey, keyFingerprint, type NodeTrustPayload } from "@agentfleet/proto";
// @ts-expect-error - no types published
import qrcode from "qrcode-terminal";
import YAML from "yaml";
import { DEFAULT_CONFIG_PATH, NodeConfig, expandHome, loadConfig, saveConfig } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { defaultIdentityPath, loadOrCreateIdentity } from "./identity.ts";
import { exec } from "./proc.ts";
import { buildAdapters, probeAll } from "./registry.ts";

declare const __AGENTFLEET_VERSION__: string | undefined;
const VERSION = typeof __AGENTFLEET_VERSION__ === "string" ? __AGENTFLEET_VERSION__ : "0.1.0";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: DEFAULT_CONFIG_PATH },
    name: { type: "string" },
    label: { type: "string", multiple: true },
    "max-concurrency": { type: "string" },
    base: { type: "string" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const configPath = resolve(expandHome(values.config!));
const [cmd, ...args] = positionals;

const USAGE = `agentfleet-node ${VERSION}
用法:
  agentfleet-node join <HUB_URL> <JOIN_TOKEN> [--name NAME] [--label L] [--max-concurrency N]
  agentfleet-node project add <NAME> <PATH> [--base REF] | project list | project remove <NAME>
  agentfleet-node key            # 显示本节点 E2EE 公钥、指纹和校验二维码
  agentfleet-node trust add <PUBKEY> | trust list | trust remove <PUBKEY>
  agentfleet-node probe
  agentfleet-node status         # 查看节点配置、E2EE 指纹和项目概览
  agentfleet-node policy
  agentfleet-node start
  全局参数: --config <path>  (默认 ${DEFAULT_CONFIG_PATH})`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (values.version) {
  console.log(`agentfleet-node ${VERSION}`);
  process.exit(0);
}

if (values.help || !cmd) {
  console.log(USAGE);
  process.exit(0);
}

switch (cmd) {
  case "join": {
    const [hub, joinToken] = args;
    if (!hub || !joinToken) die(USAGE);
    const name = values.name ?? hostname();
    const res = await fetch(new URL("/api/nodes/join", hub), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinToken, name }),
    }).catch((err: Error) => die(`无法连接 hub ${hub}: ${err.message}`));
    const body = (await res.json().catch(() => ({}))) as { nodeId?: string; nodeToken?: string; error?: string };
    if (!res.ok || !body.nodeId || !body.nodeToken) die(`加入失败: ${body.error ?? res.status}`);
    // Keep projects/agents/policy from an existing config when re-joining.
    const prev = existsSync(configPath) ? (YAML.parse(await import("node:fs").then((fs) => fs.readFileSync(configPath, "utf8"))) ?? {}) : {};
    const cfg = NodeConfig.parse({
      ...prev,
      hub,
      nodeId: body.nodeId,
      token: body.nodeToken,
      name,
      labels: values.label ?? prev.labels ?? [],
      maxConcurrency: values["max-concurrency"] ? Number(values["max-concurrency"]) : (prev.maxConcurrency ?? 2),
    });
    saveConfig(cfg, configPath);
    console.log(`✓ 已加入 hub，节点 id ${cfg.nodeId}\n  配置: ${configPath}\n下一步: agentfleet-node project add <名称> <仓库路径> && agentfleet-node start`);
    break;
  }

  case "project": {
    const cfg = loadConfig(configPath);
    const [sub, name, path] = args;
    if (sub === "add") {
      if (!name || !path) die(USAGE);
      const abs = resolve(expandHome(path));
      const r = await exec("git", ["-C", abs, "rev-parse", "--show-toplevel"]);
      if (r.code !== 0) die(`${abs} 不是 git 仓库`);
      cfg.projects[name] = { path: r.stdout.trim(), ...(values.base ? { baseRef: values.base } : {}) };
      saveConfig(cfg, configPath);
      console.log(`✓ 项目 ${name} -> ${cfg.projects[name]!.path}（重启 daemon 生效）`);
    } else if (sub === "remove") {
      if (!name || !cfg.projects[name]) die(`没有项目 ${name}`);
      delete cfg.projects[name];
      saveConfig(cfg, configPath);
      console.log(`✓ 已移除 ${name}`);
    } else {
      const entries = Object.entries(cfg.projects);
      if (entries.length === 0) console.log("（尚未添加项目）");
      for (const [n, p] of entries) console.log(`${n}\t${p.path}${p.baseRef ? `\t(base ${p.baseRef})` : ""}`);
    }
    break;
  }

  case "probe": {
    const agents = existsSync(configPath) ? loadConfig(configPath).agents : {};
    const caps = await probeAll(buildAdapters({ agents }));
    for (const c of caps) {
      const login = c.loggedIn === null ? "" : c.loggedIn ? " 已登录" : " 未登录";
      console.log(`${c.installed ? "✓" : "✗"} ${c.id.padEnd(14)} ${c.tier.padEnd(7)} ${c.version ?? "-"}${login}${c.note ? `  # ${c.note}` : ""}`);
    }
    break;
  }

  case "key": {
    const cfg = loadConfig(configPath);
    const kp = loadOrCreateIdentity(cfg.e2ee.keyPath ?? defaultIdentityPath(cfg.nodeId));
    const payload: NodeTrustPayload = { v: 1, type: "node-key", nodeId: cfg.nodeId, name: cfg.name, publicKey: kp.publicKey };
    qrcode.generate(JSON.stringify(payload), { small: true });
    console.log(`节点: ${cfg.name} (${cfg.nodeId})`);
    console.log(`指纹: ${keyFingerprint(kp.publicKey)}`);
    console.log(`公钥: ${kp.publicKey}`);
    console.log("在手机 App 的「节点」页扫码或比对指纹即可完成端到端加密校验。");
    break;
  }

  case "trust": {
    const cfg = loadConfig(configPath);
    const [sub, pub] = args;
    if (sub === "add") {
      if (!pub || !isValidPublicKey(pub)) die("请提供有效的 Base64 X25519 设备公钥");
      if (!cfg.e2ee.trustedDevices.includes(pub)) cfg.e2ee.trustedDevices.push(pub);
      saveConfig(cfg, configPath);
      console.log(`✓ 已信任设备 ${keyFingerprint(pub)}（重启 daemon 生效）`);
    } else if (sub === "remove") {
      if (!pub) die(USAGE);
      const before = cfg.e2ee.trustedDevices.length;
      cfg.e2ee.trustedDevices = cfg.e2ee.trustedDevices.filter((k) => k !== pub && keyFingerprint(k) !== pub.toUpperCase());
      if (cfg.e2ee.trustedDevices.length === before) die("未找到该设备公钥");
      saveConfig(cfg, configPath);
      console.log("✓ 已移除信任设备（重启 daemon 生效）");
    } else {
      if (cfg.e2ee.trustedDevices.length === 0) console.log("（未限制发送方设备公钥；运行 `agentfleet-node trust add <PUBKEY>` 可开启白名单）");
      for (const k of cfg.e2ee.trustedDevices) console.log(`${keyFingerprint(k)}\t${k}`);
    }
    break;
  }

  case "status": {
    const cfg = loadConfig(configPath);
    const kp = loadOrCreateIdentity(cfg.e2ee.keyPath ?? defaultIdentityPath(cfg.nodeId));
    console.log(`节点: ${cfg.name} (${cfg.nodeId})`);
    console.log(`Hub:  ${cfg.hub}`);
    console.log(`并发: ${cfg.maxConcurrency}  回合超时: ${cfg.turnTimeoutMinutes}m  空闲保活: ${cfg.idleSessionMinutes}m`);
    console.log(`E2EE: ${cfg.e2ee.mode === "required" ? "强制加密" : "自动支持"}  指纹: ${keyFingerprint(kp.publicKey)}  白名单设备: ${cfg.e2ee.trustedDevices.length}`);
    console.log(`项目: ${Object.keys(cfg.projects).join(", ") || "（无）"}`);
    break;
  }

  case "policy": {
    console.log(YAML.stringify(loadConfig(configPath).policy));
    break;
  }

  case "start": {
    const cfg = loadConfig(configPath);
    if (Object.keys(cfg.projects).length === 0) console.error("[warn] 尚未添加项目：agentfleet-node project add <名称> <路径>");
    console.error(`[info] 连接 hub ${cfg.hub} ...`);
    const daemon = await startDaemon({ cfg });
    const shutdown = async () => {
      console.error("[info] 正在停止 ...");
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }

  default:
    die(USAGE);
}
