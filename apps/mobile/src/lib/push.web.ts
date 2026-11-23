/** Web: remote push isn't supported, so every entry point is a graceful no-op. */
import type { HubClient } from "../api/client";
import { t } from "../i18n/strings";

export type PushTokenResult = { ok: true; token: string } | { ok: false; reason: string };

export function pushUnsupportedReason(): string | null {
  return t.push.unsupported.web;
}

export async function getPushToken(_opts: { prompt: boolean }): Promise<PushTokenResult> {
  return { ok: false, reason: t.push.unsupported.web };
}

export function PushManager(_props: { client: HubClient }) {
  return null;
}
