/**
 * Outbound WebSocket to the hub (`/ws/node`). Nodes dial out, so they work
 * behind NAT. Reconnects with backoff and buffers run.* messages while offline
 * so nothing is lost across short network blips (hub dedupes on runId+seq).
 */
import { HubToNode, type NodeToHub } from "@agentfleet/proto";
import WebSocket from "ws";

export interface HubClientOptions {
  hubUrl: string;
  token: string;
  /** Builds the hello message; called on every (re)connect. `pendingRunIds` = runs with unflushed messages. */
  hello: (pendingRunIds: string[]) => NodeToHub;
  onMessage: (msg: HubToNode) => void;
  heartbeat: () => NodeToHub;
  log?: (level: "info" | "warn", text: string) => void;
  heartbeatMs?: number;
  maxQueue?: number;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private queue: NodeToHub[] = [];
  private backoff = 1000;
  private stopped = false;
  private hbTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private log: NonNullable<HubClientOptions["log"]>;
  private connectedOnce: Promise<void>;
  private markConnected!: () => void;

  constructor(private opts: HubClientOptions) {
    this.log = opts.log ?? ((level, text) => console.error(`[${level}] ${text}`));
    this.connectedOnce = new Promise((r) => (this.markConnected = r));
  }

  start(): Promise<void> {
    this.connect();
    return this.connectedOnce;
  }

  /** Sends now if connected, otherwise buffers run.* messages (others are regenerated on reconnect). */
  send(msg: NodeToHub) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (!msg.type.startsWith("run.")) return;
    this.queue.push(msg);
    const max = this.opts.maxQueue ?? 10_000;
    if (this.queue.length > max) {
      // Drop the oldest streaming events first; keep lifecycle messages.
      const i = this.queue.findIndex((m) => m.type === "run.event");
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
  }

  get connected() {
    return this.ready;
  }

  async stop() {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close(1000, "shutdown");
      setTimeout(() => (ws.terminate(), resolve()), 2000).unref();
    });
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL("/ws/node", this.opts.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.opts.token}` } });
    this.ws = ws;

    ws.on("open", () => {
      const pending = [...new Set(this.queue.map((m) => ("runId" in m ? m.runId : "")).filter(Boolean))];
      ws.send(JSON.stringify(this.opts.hello(pending)));
    });

    ws.on("message", (data) => {
      let msg: HubToNode;
      try {
        msg = HubToNode.parse(JSON.parse(data.toString()));
      } catch (err) {
        this.log("warn", `invalid message from hub: ${(err as Error).message}`);
        return;
      }
      if (msg.type === "welcome") {
        this.ready = true;
        this.backoff = 1000;
        this.log("info", `已连接 hub "${msg.hubName}"（节点 ${msg.nodeId}）`);
        const q = this.queue;
        this.queue = [];
        for (const m of q) ws.send(JSON.stringify(m));
        this.hbTimer = setInterval(() => this.send(this.opts.heartbeat()), this.opts.heartbeatMs ?? 15_000);
        this.hbTimer.unref();
        this.markConnected();
        return;
      }
      if (msg.type === "error") {
        this.log("warn", `hub error: ${msg.message}`);
        return;
      }
      this.opts.onMessage(msg);
    });

    ws.on("unexpected-response", (_req, res) => {
      this.log("warn", `hub 拒绝连接: HTTP ${res.statusCode}${res.statusCode === 401 ? "（节点 token 无效，请重新 join）" : ""}`);
    });

    ws.on("error", (err) => this.log("warn", `hub 连接错误: ${err.message}`));

    ws.on("close", (code) => {
      this.ready = false;
      if (this.hbTimer) clearInterval(this.hbTimer), (this.hbTimer = null);
      if (this.stopped) return;
      if (code === 4002) this.log("warn", "协议版本不匹配，请升级 hub 或节点");
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.random() * 250);
    });
  }
}
