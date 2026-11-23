/** "端到端加密（E2EE）" section of the settings screen. */
import { StyleSheet, Switch, View } from "react-native";

import { t } from "../i18n/strings";
import { useE2EE } from "../state/e2ee";
import { MONO, useColors } from "../theme";
import { Card, SectionTitle, Txt } from "./ui";

export function E2EESettings() {
  const c = useColors();
  const { keyPair, fingerprint, enabled, setEnabled, trustedNodes } = useE2EE();
  const trustedCount = Object.keys(trustedNodes).length;

  return (
    <>
      <SectionTitle>{t.e2ee.title}</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        <View style={[styles.field, { borderBottomColor: c.border }]}>
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Txt size={15}>{t.e2ee.enableDefault}</Txt>
            <Txt muted size={12}>
              {t.e2ee.enableHint}
            </Txt>
          </View>
          <Switch value={enabled} onValueChange={(v) => void setEnabled(v)} />
        </View>
        <View style={[styles.field, { borderBottomColor: c.border }]}>
          <Txt muted size={14}>
            {t.e2ee.deviceFingerprint}
          </Txt>
          <Txt size={14} style={MONO} selectable>
            {fingerprint ?? "-"}
          </Txt>
        </View>
        <View style={[styles.field, { borderBottomColor: c.border }]}>
          <Txt muted size={14}>
            {t.e2ee.trustedCount}
          </Txt>
          <Txt size={14} color={trustedCount > 0 ? c.success : c.warning}>
            {t.e2ee.trustedNodes(trustedCount)}
          </Txt>
        </View>
        <View style={{ paddingVertical: 10, gap: 4 }}>
          <Txt muted size={13}>
            {t.e2ee.devicePublicKey}
          </Txt>
          <Txt size={12} style={MONO} selectable>
            {keyPair?.publicKey ?? "-"}
          </Txt>
        </View>
      </Card>
      <Txt muted size={12} style={styles.note}>
        {t.e2ee.trustHint}
      </Txt>
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
