import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { Hub, type HubOptions } from "./hub.ts";
import { Notifier, type NotifierConfig } from "./notify.ts";
import { createHubServer } from "./server.ts";
import { Store } from "./store.ts";

export { Hub, HubError } from "./hub.ts";
export { Store } from "./store.ts";
export { Notifier, buildNotification, type Notification, type NotifierConfig } from "./notify.ts";
export * from "./scheduler.ts";

export interface StartHubOptions extends Partial<HubOptions> {
  port?: number;
  host?: string;
  /** Directory for hub.db; use ":memory:" for tests. */
  dataDir: string;
  /** Push notification channels; `false` disables notifications entirely. Default: Expo push only. */
  notify?: NotifierConfig | false;
  /** Injected fetch for notification delivery (tests). */
  notifyFetch?: typeof fetch;
}

export async function startHub(opts: StartHubOptions) {
  let dbPath = ":memory:";
  if (opts.dataDir !== ":memory:") {
    mkdirSync(opts.dataDir, { recursive: true });
    dbPath = join(opts.dataDir, "hub.db");
  }
  const db = await openDb(dbPath);
  const store = new Store(db);
  const notifier =
    opts.notifier ??
    (opts.notify === false
      ? null
      : new Notifier(opts.notify ?? {}, { targets: () => store.pushTargets(), invalidate: (t) => store.clearPushToken(t), fetch: opts.notifyFetch }));
  const hub = new Hub(store, { name: opts.name ?? "AgentFleet Hub", ...opts, notifier });
  const server = createHubServer(hub);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    store,
    server,
    port,
    notifier,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(async () => {
          await notifier?.flush();
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
