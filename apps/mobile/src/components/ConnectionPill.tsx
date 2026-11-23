import { StyleSheet, Text, View } from "react-native";

import { t } from "../i18n/strings";
import { useSession } from "../state/session";
import { useColors } from "../theme";
import { Dot } from "./ui";

/** Small header indicator for the live WebSocket state. */
export function ConnectionPill() {
  const c = useColors();
  const { socketStatus } = useSession();
  const color = socketStatus === "open" ? c.success : socketStatus === "connecting" ? c.warning : c.danger;
  return (
    <View style={styles.pill} accessibilityLabel={t.connection[socketStatus]}>
      <Dot color={color} />
      {socketStatus !== "open" ? <Text style={{ color: c.textMuted, fontSize: 12 }}>{t.connection[socketStatus]}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 16 },
});
