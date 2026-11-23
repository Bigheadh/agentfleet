/** "推送通知" section of the settings screen. */
import type { MeResponse } from "@agentfleet/proto";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, View } from "react-native";

import { errorMessage, type HubClient } from "../api/client";
import { t } from "../i18n/strings";
import { alertMessage } from "../lib/dialog";
import { getPushToken, pushUnsupportedReason } from "../lib/push";
import { getPushPref, setPushPref } from "../state/pushPref";
import { useColors } from "../theme";
import { Card, ErrorBanner, SectionTitle, Txt } from "./ui";

function StatusRow({ label, value, color, last }: { label: string; value: string; color?: string; last?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.field, { borderBottomColor: c.border }, last && { borderBottomWidth: 0 }]}>
      <Txt muted size={14}>
        {label}
      </Txt>
      <Txt size={14} color={color} style={{ flexShrink: 1, textAlign: "right" }}>
        {value}
      </Txt>
    </View>
  );
}

export function PushSettings({ client }: { client: HubClient }) {
  const c = useColors();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const unsupported = pushUnsupportedReason();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setMe(await client.me());
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
    void getPushPref().then(setEnabled);
  }, [load]);

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (next) {
        const res = await getPushToken({ prompt: true });
        if (!res.ok) {
          alertMessage(t.push.enableFailed, res.reason);
          return;
        }
        await client.registerPush(res.token);
        await setPushPref(true);
        setEnabled(true);
      } else {
        await client.registerPush(null);
        await setPushPref(false);
        setEnabled(false);
      }
    } catch (e) {
      alertMessage(next ? t.push.enableFailed : t.push.disableFailed, errorMessage(e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const expoEnabled = me?.push.expoEnabled ?? false;
  // Allow turning off even when unsupported / hub-disabled, so a stale registration can be cleared.
  const canToggle = !busy && (enabled || (!unsupported && expoEnabled));

  return (
    <>
      <SectionTitle>{t.push.title}</SectionTitle>
      {loadError ? <ErrorBanner message={`${t.push.loadFailed}：${loadError}`} onRetry={() => void load()} /> : null}
      <Card style={{ paddingVertical: 4 }}>
        <View style={[styles.field, { borderBottomColor: c.border }]}>
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Txt size={15}>{t.push.enable}</Txt>
            <Txt muted size={12}>
              {t.push.enableHint}
            </Txt>
          </View>
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Switch value={enabled} disabled={!canToggle} onValueChange={(v) => void toggle(v)} />
          )}
        </View>
        <StatusRow
          label={t.push.hubExpo}
          value={me ? (me.push.expoEnabled ? t.push.enabled : t.push.disabled) : "-"}
          color={me ? (me.push.expoEnabled ? c.success : c.warning) : undefined}
        />
        <StatusRow
          label={t.push.deviceRegistered}
          value={me ? (me.push.registered ? t.push.registered : t.push.notRegistered) : "-"}
          color={me?.push.registered ? c.success : undefined}
        />
        <StatusRow
          label={t.push.otherChannels}
          value={me ? (me.push.channels.length ? me.push.channels.join("、") : t.common.none) : "-"}
          last
        />
      </Card>
      {me && !me.push.expoEnabled ? (
        <Txt muted size={12} style={styles.note}>
          {t.push.hubExpoDisabled}
        </Txt>
      ) : null}
      {unsupported ? (
        <Txt muted size={12} style={styles.note}>
          {unsupported}
        </Txt>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  note: { marginTop: 8, marginHorizontal: 4 },
});
