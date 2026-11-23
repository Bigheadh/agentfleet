/** Persistence for the hub. Tasks/runs are stored as validated JSON blobs. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEnvelope, FleetEvent, NodeInfo, Run, Task } from "@agentfleet/proto";
import type { Db } from "./db.ts";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
export const newId = () => randomUUID();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS pairing_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS join_tokens (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, info TEXT, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
`;

export class Store {
  constructor(private db: Db) {
    db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive, idempotent migrations for hub.db files created by older versions. */
  private migrate() {
    const cols = new Set(this.db.all<{ name: string }>("PRAGMA table_info(devices)").map((c) => c.name));
    if (!cols.has("push_token")) this.db.exec("ALTER TABLE devices ADD COLUMN push_token TEXT");
    if (!cols.has("public_key")) this.db.exec("ALTER TABLE devices ADD COLUMN public_key TEXT");
  }

  // ---- devices & pairing -------------------------------------------------
  createPairingCode(ttlMs = 10 * 60_000): string {
    const code = randomBytes(5).toString("hex").toUpperCase();
    this.db.run("INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)", code, Date.now() + ttlMs);
    return code;
  }

  /** Consumes a one-time pairing code and registers a device. Returns null if invalid/expired. */
  pairDevice(code: string, name: string, publicKey?: string): { id: string; token: string } | null {
    const row = this.db.get<{ expires_at: number }>("SELECT expires_at FROM pairing_codes WHERE code = ?", code.toUpperCase());
    this.db.run("DELETE FROM pairing_codes WHERE code = ? OR expires_at < ?", code.toUpperCase(), Date.now());
    if (!row || row.expires_at < Date.now()) return null;
    const id = newId();
    const token = newToken("afd");
    this.db.run(
      "INSERT INTO devices (id, name, token_hash, created_at, public_key) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      sha256(token),
      Date.now(),
      publicKey ?? null,
    );
    this.audit(`device:${id}`, "pair", name);
    return { id, token };
  }

  deviceByToken(token: string): { id: string; name: string } | undefined {
    return this.db.get("SELECT id, name FROM devices WHERE token_hash = ?", sha256(token));
  }

  countDevices(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices")?.n ?? 0;
  }

  revokeDevice(id: string) {
    this.db.run("DELETE FROM devices WHERE id = ?", id);
  }

  // ---- device E2EE public keys -----------------------------------------------
  setDevicePublicKey(deviceId: string, publicKey: string) {
    this.db.run("UPDATE devices SET public_key = ? WHERE id = ?", publicKey, deviceId);
  }

  devicePublicKey(deviceId: string): string | null {
    return this.db.get<{ public_key: string | null }>("SELECT public_key FROM devices WHERE id = ?", deviceId)?.public_key ?? null;
  }

  allDevicePublicKeys(): string[] {
    return [
      ...new Set(
        this.db.all<{ public_key: string }>("SELECT public_key FROM devices WHERE public_key IS NOT NULL").map((r) => r.public_key),
      ),
    ];
  }

  // ---- push tokens -----------------------------------------------------------
  setPushToken(deviceId: string, token: string | null) {
    // A token belongs to one physical install: if it moved to a re-paired device, drop the stale owner.
    if (token) this.db.run("UPDATE devices SET push_token = NULL WHERE push_token = ? AND id != ?", token, deviceId);
    this.db.run("UPDATE devices SET push_token = ? WHERE id = ?", token, deviceId);
  }

  pushToken(deviceId: string): string | null {
    return this.db.get<{ push_token: string | null }>("SELECT push_token FROM devices WHERE id = ?", deviceId)?.push_token ?? null;
  }

  pushTargets(): { deviceId: string; token: string }[] {
    return this.db
      .all<{ id: string; push_token: string }>("SELECT id, push_token FROM devices WHERE push_token IS NOT NULL")
      .map((r) => ({ deviceId: r.id, token: r.push_token }));
  }

  clearPushToken(token: string) {
    this.db.run("UPDATE devices SET push_token = NULL WHERE push_token = ?", token);
  }

  // ---- nodes ---------------------------------------------------------------
  createJoinToken(ttlMs = 60 * 60_000): string {
    const token = newToken("afj");
    this.db.run("INSERT INTO join_tokens (token_hash, expires_at) VALUES (?, ?)", sha256(token), Date.now() + ttlMs);
    return token;
  }

  /** Exchanges a join token (reusable until expiry) for a long-lived node credential. */
  joinNode(joinToken: string, name: string): { nodeId: string; nodeToken: string } | null {
    const row = this.db.get<{ expires_at: number }>("SELECT expires_at FROM join_tokens WHERE token_hash = ?", sha256(joinToken));
    if (!row || row.expires_at < Date.now()) return null;
    const nodeId = newId();
    const nodeToken = newToken("afn");
    this.db.run("INSERT INTO nodes (id, name, token_hash) VALUES (?, ?, ?)", nodeId, name, sha256(nodeToken));
    this.audit(`node:${nodeId}`, "join", name);
    return { nodeId, nodeToken };
  }

  nodeByToken(token: string): { id: string; name: string } | undefined {
    return this.db.get("SELECT id, name FROM nodes WHERE token_hash = ?", sha256(token));
  }

  saveNodeInfo(info: NodeInfo) {
    this.db.run("UPDATE nodes SET info = ?, name = ?, last_seen = ? WHERE id = ?", JSON.stringify(info), info.name, info.lastSeen, info.id);
  }

  listNodeInfos(): NodeInfo[] {
    return this.db
      .all<{ info: string | null }>("SELECT info FROM nodes WHERE info IS NOT NULL")
      .map((r) => NodeInfo.parse(JSON.parse(r.info!)));
  }

  // ---- tasks & runs ----------------------------------------------------------
  saveTask(task: Task) {
    this.db.run(
      "INSERT INTO tasks (id, state, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data",
      task.id,
      task.state,
      task.createdAt,
      JSON.stringify(task),
    );
  }

  getTask(id: string): Task | undefined {
    const r = this.db.get<{ data: string }>("SELECT data FROM tasks WHERE id = ?", id);
    return r ? Task.parse(JSON.parse(r.data)) : undefined;
  }

  listTasks(limit = 200): Task[] {
    return this.db
      .all<{ data: string }>("SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?", limit)
      .map((r) => Task.parse(JSON.parse(r.data)));
  }

  tasksInState(...states: Task["state"][]): Task[] {
    const qs = states.map(() => "?").join(",");
    return this.db
      .all<{ data: string }>(`SELECT data FROM tasks WHERE state IN (${qs}) ORDER BY created_at ASC`, ...states)
      .map((r) => Task.parse(JSON.parse(r.data)));
  }

  saveRun(run: Run) {
    this.db.run(
      "INSERT INTO runs (id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      run.id,
      run.taskId,
      JSON.stringify(run),
    );
  }

  getRun(id: string): Run | undefined {
    const r = this.db.get<{ data: string }>("SELECT data FROM runs WHERE id = ?", id);
    return r ? Run.parse(JSON.parse(r.data)) : undefined;
  }

  runsForTask(taskId: string): Run[] {
    return this.db
      .all<{ data: string }>("SELECT data FROM runs WHERE task_id = ?", taskId)
      .map((r) => Run.parse(JSON.parse(r.data)))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  activeRunsOnNode(nodeId: string): Run[] {
    return this.db
      .all<{ data: string }>("SELECT data FROM runs")
      .map((r) => Run.parse(JSON.parse(r.data)))
      .filter((r) => r.nodeId === nodeId && r.endedAt === null);
  }

  // ---- events ----------------------------------------------------------------
  /** Returns false if (runId, seq) already exists (duplicate after reconnect). */
  appendEvent(env: EventEnvelope): boolean {
    const r = this.db.run(
      "INSERT OR IGNORE INTO events (run_id, seq, ts, event) VALUES (?, ?, ?, ?)",
      env.runId,
      env.seq,
      env.ts,
      JSON.stringify(env.event),
    );
    return r.changes > 0;
  }

  eventsAfter(runId: string, after: number, limit = 5000): EventEnvelope[] {
    return this.db
      .all<{ seq: number; ts: number; event: string }>(
        "SELECT seq, ts, event FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        runId,
        after,
        limit,
      )
      .map((r) => ({ runId, seq: r.seq, ts: r.ts, event: FleetEvent.parse(JSON.parse(r.event)) }));
  }

  audit(actor: string, action: string, detail?: string) {
    this.db.run("INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)", Date.now(), actor, action, detail ?? null);
  }
}
