import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { Hub, type HubOptions } from "./hub.ts";
import { createHubServer } from "./server.ts";
import { Store } from "./store.ts";

export { Hub, HubError } from "./hub.ts";
export { Store } from "./store.ts";
export * from "./scheduler.ts";

export interface StartHubOptions extends Partial<HubOptions> {
  port?: number;
  host?: string;
  /** Directory for hub.db; use ":memory:" for tests. */
  dataDir: string;
}

export async function startHub(opts: StartHubOptions) {
  let dbPath = ":memory:";
  if (opts.dataDir !== ":memory:") {
    mkdirSync(opts.dataDir, { recursive: true });
    dbPath = join(opts.dataDir, "hub.db");
  }
  const db = await openDb(dbPath);
  const store = new Store(db);
  const hub = new Hub(store, { name: opts.name ?? "AgentFleet Hub", ...opts });
  const server = createHubServer(hub);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    store,
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
