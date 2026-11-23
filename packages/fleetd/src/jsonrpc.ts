/**
 * Tiny bidirectional JSON-RPC 2.0 peer over newline-delimited JSON (stdio).
 * Used for the Codex app-server, which omits the `"jsonrpc":"2.0"` header on the wire.
 */
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

type Id = number | string;
interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  method: string;
}

export class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private closed = false;
  onRequest: RequestHandler = async (method) => {
    throw new JsonRpcError(-32601, `method not found: ${method}`);
  };
  onNotification: NotificationHandler = () => {};
  onProtocolError: (line: string, err: unknown) => void = () => {};

  constructor(
    private out: Writable,
    input: Readable,
    private opts: { includeJsonrpcHeader?: boolean } = {},
  ) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    rl.on("close", () => this.dispose(new Error("stream closed")));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.closed) this.write({ method, params });
  }

  dispose(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private write(msg: Record<string, unknown>) {
    const payload = this.opts.includeJsonrpcHeader ? { jsonrpc: "2.0", ...msg } : msg;
    this.out.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      return this.onProtocolError(line, err);
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      this.onRequest(msg.method, msg.params).then(
        (result) => this.write({ id, result: result ?? null }),
        (err) => {
          const e = err instanceof JsonRpcError ? err : new JsonRpcError(-32603, String((err as Error)?.message ?? err));
          this.write({ id, error: { code: e.code, message: e.message, data: e.data } });
        },
      );
    } else if (msg.method !== undefined) {
      this.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new JsonRpcError(msg.error.code, `${p.method}: ${msg.error.message}`, msg.error.data));
      else p.resolve(msg.result);
    }
  }
}
