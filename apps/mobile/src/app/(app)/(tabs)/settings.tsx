import Constants from "expo-constants";
import { ScrollView, StyleSheet, View } from "react-native";

import { PushSettings } from "@/components/PushSettings";
import { Button, Card, Dot, Row, SectionTitle, Txt } from "@/components/ui";
import { t } from "@/i18n/strings";
import { confirmAsync } from "@/lib/dialog";
import { usePaired, useSession } from "@/state/session";
import { MONO, useColors } from "@/theme";

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.field, { borderBottomColor: c.border }]}>
      <Txt muted size={14}>
        {label}
      </Txt>
      <Txt size={14} selectable style={[{ flexShrink: 1, textAlign: "right" }, mono && MONO]} numberOfLines={2}>
        {value}
      </Txt>
    </View>
  );
}

export default function SettingsScreen() {
  const c = useColors();
  const { session, client, socketStatus } = usePaired();
  const { unpair } = useSession();
  const statusColor = socketStatus === "open" ? c.success : socketStatus === "connecting" ? c.warning : c.danger;

  const onUnpair = async () => {
    if (await confirmAsync(t.settings.unpair, t.settings.unpairConfirm, { destructive: true, confirmText: t.settings.unpair })) {
      await unpair();
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <SectionTitle>{t.settings.hub}</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        <Field label={t.settings.hubName} value={session.hubName} />
        <Field label={t.settings.hubUrl} value={session.hub} mono />
        <Field label={t.pair.deviceName} value={session.deviceName} />
        <Field label={t.settings.deviceId} value={session.deviceId} mono />
        <View style={[styles.field, { borderBottomWidth: 0 }]}>
          <Txt muted size={14}>
            {t.settings.connection}
          </Txt>
          <Row gap={6}>
            <Dot color={statusColor} />
            <Txt size={14}>{t.connection[socketStatus]}</Txt>
          </Row>
        </View>
      </Card>

      <PushSettings client={client} />

      <SectionTitle>{t.appName}</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        <View style={[styles.field, { borderBottomWidth: 0 }]}>
          <Txt muted size={14}>
            {t.settings.version}
          </Txt>
          <Txt size={14}>{Constants.expoConfig?.version ?? "-"}</Txt>
        </View>
      </Card>

      <Button title={t.settings.unpair} variant="danger" onPress={() => void onUnpair()} style={{ marginTop: 28 }} />
      <Txt muted size={12} style={{ marginTop: 8, textAlign: "center" }}>
        {t.settings.unpairNote}
      </Txt>
    </ScrollView>
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
});
