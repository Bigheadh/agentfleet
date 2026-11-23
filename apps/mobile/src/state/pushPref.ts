/** Persisted "push notifications enabled" preference (secure store on native, localStorage on web). */
import * as storage from "./storage";

const KEY = "agentfleet.push.enabled.v1";

export async function getPushPref(): Promise<boolean> {
  try {
    return (await storage.getItem(KEY)) === "1";
  } catch {
    return false;
  }
}

export async function setPushPref(enabled: boolean): Promise<void> {
  try {
    if (enabled) await storage.setItem(KEY, "1");
    else await storage.removeItem(KEY);
  } catch {
    // Preference is best-effort; the hub's registration state is authoritative.
  }
}
