#!/usr/bin/env node
/**
 * agentfleet-hub CLI
 *
 *   agentfleet-hub start [--port 8787] [--data ~/.agentfleet/hub] [--name "My Hub"] [--public-url http://host:8787]
 *                        [--ntfy-url https://ntfy.sh/<topic>] [--webhook-url URL] [--no-expo-push] [--push-redact]
 *   agentfleet-hub pair       [--data ...] [--public-url ...]   # print a phone pairing QR code
 *   agentfleet-hub join-token [--data ...] [--public-url ...]   # print a node join command
 */
import { networkInterfaces, homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keyFingerprint, type PairingPayload } from "@agentfleet/proto";
// @ts-expect-error - no types published
import qrcode from "qrcode-terminal";
import { openDb } from "./db.ts";
import { startHub } from "./index.ts";
import { Store } from "./store.ts";

declare const __AGENTFLEET_VERSION__: string | undefined;
const VERSION = typeof __AGENTFLEET_VERSION__ === "string" ? __AGENTFLEET_VERSION__ : "0.1.0";

const env = process.env;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: env.AGENTFLEET_PORT || "8787" },
    host: { type: "string", default: "0.0.0.0" },
    data: { type: "string", default: env.AGENTFLEET_HUB_DATA || join(homedir(), ".agentfleet", "hub") },
    name: { type: "string", default: env.AGENTFLEET_HUB_NAME || "AgentFleet Hub" },
    "public-url": { type: "string", default: env.AGENTFLEET_PUBLIC_URL || undefined },
    "ntfy-url": { type: "string", default: env.AGENTFLEET_NTFY_URL || undefined },
    "webhook-url": { type: "string", default: env.AGENTFLEET_WEBHOOK_URL || undefined },
    "no-expo-push": { type: "boolean", default: env.AGENTFLEET_EXPO_PUSH === "0" },
    "push-redact": { type: "boolean", default: env.AGENTFLEET_PUSH_REDACT === "1" },
    limit: { type: "string", default: "50" },
    json: { type: "boolean", default: false },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = positionals[0] ?? "start";
const publicUrl = values["public-url"] || `http://${lanAddress()}:${values.port}`;

if (values.version) {
  console.log(`agentfleet-hub ${VERSION}`);
  process.exit(0);
}

if (values.help) {
  console.log(
    [
      `agentfleet-hub ${VERSION}`,
      "usage: agentfleet-hub [start|pair|join-token|devices|revoke <id>|audit] [--port N] [--data DIR] [--name NAME] [--public-url URL]",
      "  notifications: [--ntfy-url https://ntfy.sh/<topic>] [--webhook-url URL] [--no-expo-push] [--push-redact]",
      "  audit: [--limit N] [--json]",
      "  env: AGENTFLEET_NTFY_URL, AGENTFLEET_NTFY_TOKEN, AGENTFLEET_WEBHOOK_URL, AGENTFLEET_EXPO_PUSH=0, AGENTFLEET_PUSH_REDACT=1",
    ].join("\n"),
  );
  process.exit(0);
}

if (cmd === "start") {
  const h = await startHub({
    port: Number(values.port),
    host: values.host,
    dataDir: values.data!,
    name: values.name,
    notify: {
      expo: !values["no-expo-push"],
      ntfyUrl: values["ntfy-url"] || undefined,
      ntfyToken: env.AGENTFLEET_NTFY_TOKEN || undefined,
      webhookUrl: values["webhook-url"] || undefined,
      redact: values["push-redact"],
    },
  });
  console.log(`[hub] "${h.hub.name}" listening on :${h.port}  (data: ${values.data})`);
  console.log(`[hub] public URL: ${publicUrl}`);
  const channels = [...(h.notifier?.expoEnabled ? ["expo"] : []), ...(h.notifier?.channels() ?? [])];
  console.log(`[hub] 推送通道: ${channels.join(", ") || "无"}${values["push-redact"] ? "（隐藏详情）" : ""}`);
  if (h.store.countDevices() === 0) {
    console.log("[hub] 还没有配对的手机，扫描下方二维码配对：");
    printPairing(h.store, values.name!);
  }
  if (h.hub.nodeInfos().length === 0) printJoin(h.store);
  const stop = async () => {
    console.log("\n[hub] shutting down");
    await h.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else if (cmd === "pair" || cmd === "join-token" || cmd === "devices" || cmd === "revoke" || cmd === "audit") {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(values.data!, { recursive: true });
  const db = await openDb(join(values.data!, "hub.db"));
  const store = new Store(db);
  if (cmd === "pair") {
    printPairing(store, values.name!);
  } else if (cmd === "join-token") {
    printJoin(store);
  } else if (cmd === "devices") {
    const list = store.listDevices();
    if (values.json) {
      console.log(JSON.stringify(list, null, 2));
    } else if (list.length === 0) {
      console.log("（尚未配对任何设备）");
    } else {
      for (const d of list) {
        const fp = d.publicKey ? keyFingerprint(d.publicKey) : "-";
        const seen = d.lastSeen ? new Date(d.lastSeen).toISOString() : "-";
        console.log(`${d.id}\t${d.name}\tE2EE=${fp}\tpush=${d.hasPush ? "on" : "off"}\tseen=${seen}`);
      }
    }
  } else if (cmd === "revoke") {
    const id = positionals[1];
    if (!id) {
      console.error("usage: agentfleet-hub revoke <deviceId>");
      db.close();
      process.exit(1);
    }
    const ok = store.revokeDevice(id);
    if (!ok) {
      console.error(`未找到设备: ${id}`);
      db.close();
      process.exit(1);
    }
    store.audit("cli", "device.revoke", id);
    console.log(`✓ 已吊销设备 ${id}`);
  } else if (cmd === "audit") {
    const rows = store.listAudit(Number(values.limit) || 50);
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        console.log(`${new Date(r.ts).toISOString()}\t${r.actor}\t${r.action}\t${r.detail ?? ""}`);
      }
    }
  }
  db.close();
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

function printPairing(store: Store, name: string) {
  const payload: PairingPayload = { v: 1, hub: publicUrl, code: store.createPairingCode(), name };
  const text = JSON.stringify(payload);
  qrcode.generate(text, { small: true });
  console.log(`配对信息（10 分钟内有效，一次性）：\n  Hub:  ${payload.hub}\n  Code: ${payload.code}`);
}

function printJoin(store: Store) {
  const token = store.createJoinToken();
  console.log(`\n在要加入的机器上运行（1 小时内有效）：\n  agentfleet-node join ${publicUrl} ${token}\n`);
}

function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "localhost";
}
