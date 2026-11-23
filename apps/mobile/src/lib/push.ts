/**
 * Native push notifications (expo-notifications). Metro picks push.web.ts for
 * the web bundle, so nothing here is loaded in the browser.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import type { HubClient } from "../api/client";
import { t } from "../i18n/strings";
import { getPushPref } from "../state/pushPref";
import { ANDROID_CHANNEL_ID, foregroundBehavior, precheckPush, resolveProjectId, routeForNotificationResponse } from "./pushData";

export type PushTokenResult = { ok: true; token: string } | { ok: false; reason: string };

// Decide how notifications are presented while the app is in the foreground.
// Set at module load so it is in place before the first notification arrives.
try {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => foregroundBehavior(n.request.content.data),
  });
} catch (e) {
  if (__DEV__) console.warn("[push] setNotificationHandler failed", e);
}

function precheck() {
  return precheckPush({
    platform: Platform.OS,
    isDevice: Device.isDevice,
    executionEnvironment: Constants.executionEnvironment,
    projectId: resolveProjectId(Constants.expoConfig, Constants.easConfig),
  });
}

/** A Chinese explanation when this build/device can't receive remote push, else null. */
export function pushUnsupportedReason(): string | null {
  const pre = precheck();
  return pre.ok ? null : t.push.unsupported[pre.reason];
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  // Must exist before requesting permission on Android 13+.
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: t.appName,
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
}

/**
 * Obtain this device's Expo push token. With `prompt`, asks for notification
 * permission if it hasn't been decided yet; without it (background
 * re-registration) only uses an existing grant. Never throws.
 */
export async function getPushToken({ prompt }: { prompt: boolean }): Promise<PushTokenResult> {
  const pre = precheck();
  if (!pre.ok) return { ok: false, reason: t.push.unsupported[pre.reason] };
  try {
    await ensureAndroidChannel();
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && prompt && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: t.push.permissionDenied };
    const token = await Notifications.getExpoPushTokenAsync({ projectId: pre.projectId });
    return { ok: true, token: token.data };
  } catch (e) {
    return { ok: false, reason: t.push.tokenFailed(e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Mounted in the authenticated layout (only while paired):
 * - re-registers the push token on start when the user enabled push (tokens can change);
 * - navigates to the task when a notification is tapped, including cold starts.
 */
export function PushManager({ client }: { client: HubClient }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await getPushPref())) return;
      const res = await getPushToken({ prompt: false });
      if (cancelled) return;
      if (!res.ok) {
        if (__DEV__) console.warn("[push] re-register skipped:", res.reason);
        return;
      }
      await client.registerPush(res.token);
    })().catch((e) => {
      if (__DEV__) console.warn("[push] re-register failed", e);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const lastResponse = Notifications.useLastNotificationResponse();
  const navReady = !!useRootNavigationState()?.key;
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!lastResponse || !navReady) return;
    const id = lastResponse.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    // Clear so a later remount (e.g. after re-pairing) doesn't navigate again.
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
    const route = routeForNotificationResponse(lastResponse);
    if (!route || safeDecode(route) === safeDecode(pathnameRef.current)) return;
    router.push(route);
  }, [lastResponse, navReady]);

  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
