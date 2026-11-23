/**
 * Pairing session (hub URL + device token) and the long-lived API client and
 * live socket derived from it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { z } from "zod";

import { HubClient, pairWithHub } from "../api/client";
import { LiveSocket, type SocketStatus } from "../api/ws";
import { setPushPref } from "./pushPref";
import * as storage from "./storage";

const STORAGE_KEY = "agentfleet.session.v1";
const UNREGISTER_TIMEOUT_MS = 3_000;

const StoredSession = z.object({
  hub: z.string(),
  token: z.string(),
  deviceId: z.string(),
  hubName: z.string(),
  deviceName: z.string(),
  pairedAt: z.number(),
});
export type Session = z.infer<typeof StoredSession>;

interface SessionContextValue {
  /** false until the stored session has been read. */
  ready: boolean;
  session: Session | null;
  client: HubClient | null;
  socket: LiveSocket | null;
  socketStatus: SocketStatus;
  pair: (hub: string, code: string, deviceName: string) => Promise<Session>;
  unpair: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("closed");

  useEffect(() => {
    let cancelled = false;
    storage
      .getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = StoredSession.safeParse(JSON.parse(raw));
        if (parsed.success) setSession(parsed.data);
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const client = useMemo(() => (session ? new HubClient(session.hub, session.token) : null), [session]);
  const socket = useMemo(() => (session ? new LiveSocket(session.hub, session.token) : null), [session]);

  useEffect(() => {
    if (!socket) {
      setSocketStatus("closed");
      return;
    }
    const off = socket.onStatus(setSocketStatus);
    socket.start();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") socket.kick();
    });
    return () => {
      off();
      sub.remove();
      socket.stop();
    };
  }, [socket]);

  const pair = useCallback(async (hub: string, code: string, deviceName: string) => {
    const res = await pairWithHub(hub, code.trim(), deviceName.trim());
    const s: Session = {
      hub,
      token: res.token,
      deviceId: res.deviceId,
      hubName: res.hubName,
      deviceName: deviceName.trim(),
      pairedAt: Date.now(),
    };
    await storage.setItem(STORAGE_KEY, JSON.stringify(s));
    setSession(s);
    return s;
  }, []);

  const unpair = useCallback(async () => {
    // Best effort: stop the hub pushing to this device. Bounded so an
    // unreachable hub doesn't block unpairing.
    if (client) {
      await Promise.race([
        client.registerPush(null).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, UNREGISTER_TIMEOUT_MS)),
      ]);
    }
    await setPushPref(false);
    await storage.removeItem(STORAGE_KEY);
    setSession(null);
  }, [client]);

  const value = useMemo<SessionContextValue>(
    () => ({ ready, session, client, socket, socketStatus, pair, unpair }),
    [ready, session, client, socket, socketStatus, pair, unpair],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

/**
 * For screens under (app), which are only mounted while paired. Returns the
 * last paired values during the brief unpair → redirect transition instead of
 * throwing.
 */
export function usePaired(): { session: Session; client: HubClient; socket: LiveSocket; socketStatus: SocketStatus } {
  const { session, client, socket, socketStatus } = useSession();
  const last = useRef<{ session: Session; client: HubClient; socket: LiveSocket } | null>(null);
  if (session && client && socket) last.current = { session, client, socket };
  if (!last.current) throw new Error("usePaired used outside a paired screen");
  return { ...last.current, socketStatus };
}
