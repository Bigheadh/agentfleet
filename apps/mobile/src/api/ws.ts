/**
 * Live connection to the hub (`/ws/client?token=...`).
 *
 * - Auto-reconnects with exponential backoff (1s → 30s, jittered).
 * - Keeps a registry of run subscriptions and re-sends `subscribe` with the
 *   subscriber's current `lastSeq` after every reconnect, so no events are lost
 *   (the reducer dedupes by seq).
 * - Sends an application-level `ping` every 25s so idle proxies don't drop us.
 * - Validates every frame with `HubToClient`.
 */
import { HubToClient, type ClientToHub, type EventEnvelope, type NodeInfo, type Run, type Task } from "@agentfleet/proto";

import { liveSocketUrl } from "../lib/url";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketListeners {
  task?: (task: Task) => void;
  run?: (run: Run) => void;
  node?: (node: NodeInfo) => void;
  error?: (message: string) => void;
  /** Fired on every successful (re)connect; use it to refetch lists. */
  open?: (reconnect: boolean) => void;
}

interface RunSubscription {
  onEvent: (envelope: EventEnvelope) => void;
  /** Called at (re)subscribe time to get the `after` cursor. */
  getAfter: () => number;
}

const PING_INTERVAL_MS = 25_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private status: SocketStatus = "closed";
  private stopped = true;
  private attempt = 0;
  private everOpened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<SocketListeners>();
  private readonly statusListeners = new Set<(s: SocketStatus) => void>();
  /** runId → set of subscribers (several screens may watch the same run). */
  private readonly runs = new Map<string, Set<RunSubscription>>();

  constructor(
    private readonly hub: string,
    private readonly token: string,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }

  /** Force an immediate reconnect attempt (e.g. app returned to foreground). */
  kick(): void {
    if (this.stopped || this.status === "open" || this.status === "connecting") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  onStatus(fn: (s: SocketStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  addListeners(l: SocketListeners): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Subscribe to a run's event stream. `getAfter` should return the highest seq
   * the caller has already applied (or -1).
   */
  subscribeRun(runId: string, onEvent: (e: EventEnvelope) => void, getAfter: () => number): () => void {
    const sub: RunSubscription = { onEvent, getAfter };
    let set = this.runs.get(runId);
    if (!set) {
      set = new Set();
      this.runs.set(runId, set);
    }
    set.add(sub);
    // Always (re)send: if another screen already watches this run, the hub
    // backfills from our cursor; duplicates are filtered by seq downstream.
    this.send({ type: "subscribe", runId, after: getAfter() });
    return () => {
      const s = this.runs.get(runId);
      if (!s) return;
      s.delete(sub);
      if (s.size === 0) {
        this.runs.delete(runId);
        this.send({ type: "unsubscribe", runId });
      }
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveSocketUrl(this.hub, this.token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus("open");
      for (const [runId, subs] of this.runs) {
        let after = Number.POSITIVE_INFINITY;
        for (const s of subs) after = Math.min(after, s.getAfter());
        this.send({ type: "subscribe", runId, after: Number.isFinite(after) ? after : -1 });
      }
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
      for (const l of this.listeners) l.open?.(reconnect);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.setStatus("closed");
      this.scheduleReconnect();
    };
  }

  private handleFrame(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = HubToClient.safeParse(json);
    if (!parsed.success) {
      if (__DEV__) console.warn("[ws] dropped invalid frame", parsed.error.issues);
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "event": {
        const subs = this.runs.get(msg.envelope.runId);
        if (subs) for (const s of subs) s.onEvent(msg.envelope);
        break;
      }
      case "task":
        for (const l of this.listeners) l.task?.(msg.task);
        break;
      case "run":
        for (const l of this.listeners) l.run?.(msg.run);
        break;
      case "node":
        for (const l of this.listeners) l.node?.(msg.node);
        break;
      case "error":
        for (const l of this.listeners) l.error?.(msg.message);
        break;
      case "pong":
        break;
    }
  }

  private send(msg: ClientToHub): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    // When not open, subscriptions are replayed in onopen.
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
}
