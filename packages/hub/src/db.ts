/**
 * Minimal SQLite facade that works on both Node (>=22.13, `node:sqlite`) and Bun
 * (`bun:sqlite`), so the hub can run under `tsx` in development and ship as a
 * single `bun build --compile` binary.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export async function openDb(path: string): Promise<Db> {
  if (isBun) {
    const modName = "bun:sqlite";
    const { Database } = (await import(modName)) as {
      Database: new (p: string) => {
        exec(s: string): void;
        query(s: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number } };
        close(): void;
      };
    };
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    return {
      exec: (s) => db.exec(s),
      run: (s, ...p) => db.query(s).run(...p),
      get: <T>(s: string, ...p: SqlValue[]) => (db.query(s).get(...p) ?? undefined) as T | undefined,
      all: <T>(s: string, ...p: SqlValue[]) => db.query(s).all(...p) as T[],
      close: () => db.close(),
    };
  }

  silenceSqliteExperimentalWarning();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return {
    exec: (s) => db.exec(s),
    run: (s, ...p) => {
      const r = db.prepare(s).run(...p);
      return { changes: Number(r.changes) };
    },
    get: <T>(s: string, ...p: SqlValue[]) => db.prepare(s).get(...p) as T | undefined,
    all: <T>(s: string, ...p: SqlValue[]) => db.prepare(s).all(...p) as T[],
    close: () => db.close(),
  };
}

let silenced = false;
function silenceSqliteExperimentalWarning() {
  if (silenced) return;
  silenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning.message;
    if (msg.includes("SQLite is an experimental feature")) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
