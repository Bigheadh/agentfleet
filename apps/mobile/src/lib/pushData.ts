/**
 * Pure, platform-independent push-notification helpers (no react-native /
 * expo imports, so they can be unit-tested under vitest).
 */
import { PushData } from "@agentfleet/proto";

/** Android notification channel used by the hub for every push. */
export const ANDROID_CHANNEL_ID = "agentfleet";

/** Mirrors `Notifications.DEFAULT_ACTION_IDENTIFIER` (the user tapped the notification body). */
export const DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";

/** Validates a notification's `data` payload against the proto schema. */
export function parsePushData(data: unknown): PushData | null {
  const parsed = PushData.safeParse(data);
  return parsed.success && parsed.data.taskId.length > 0 ? parsed.data : null;
}

/** expo-router path of the task detail screen for a push payload. */
export function routeForPushData(data: PushData): string {
  return `/tasks/${encodeURIComponent(data.taskId)}`;
}

/** Structural subset of expo-notifications' `NotificationResponse` that we rely on. */
export interface NotificationResponseLike {
  actionIdentifier: string;
  notification: { request: { identifier: string; content: { data?: unknown } } };
}

/**
 * Decides where tapping a notification should navigate. Returns null for
 * non-default actions (e.g. dismiss / custom action buttons) and for payloads
 * that are not AgentFleet push data.
 */
export function routeForNotificationResponse(response: NotificationResponseLike | null | undefined): string | null {
  if (!response || response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return null;
  const data = parsePushData(response.notification.request.content.data);
  return data ? routeForPushData(data) : null;
}

/** Foreground presentation: always show; play a sound only for approvals (they block the agent). */
export function foregroundBehavior(data: unknown): {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
} {
  const parsed = parsePushData(data);
  return {
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: parsed?.kind === "approval",
    shouldSetBadge: false,
  };
}

/** EAS project id from the app config (`extra.eas.projectId`) or the EAS update/build manifest. */
export function resolveProjectId(
  expoConfig: { extra?: { eas?: { projectId?: unknown } | null } | null } | null | undefined,
  easConfig: { projectId?: unknown } | null | undefined,
): string | null {
  const candidates = [expoConfig?.extra?.eas?.projectId, easConfig?.projectId];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

export type PushPrecheck =
  | { ok: true; projectId: string }
  | { ok: false; reason: "web" | "simulator" | "expoGoAndroid" | "noProjectId" };

/** Environment checks that must pass before asking for a push token. */
export function precheckPush(env: {
  platform: string;
  isDevice: boolean;
  /** `Constants.executionEnvironment` ("storeClient" = Expo Go). */
  executionEnvironment?: string;
  projectId: string | null;
}): PushPrecheck {
  if (env.platform === "web") return { ok: false, reason: "web" };
  if (!env.isDevice) return { ok: false, reason: "simulator" };
  if (env.platform === "android" && env.executionEnvironment === "storeClient") return { ok: false, reason: "expoGoAndroid" };
  if (!env.projectId) return { ok: false, reason: "noProjectId" };
  return { ok: true, projectId: env.projectId };
}
