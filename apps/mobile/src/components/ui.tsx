/** Small set of styled primitives shared by all screens. */
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { t } from "../i18n/strings";
import { useColors } from "../theme";

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, style]}>{children}</View>;
}

export function Txt({
  children,
  muted,
  size = 15,
  weight,
  color,
  style,
  numberOfLines,
  selectable,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  weight?: TextStyle["fontWeight"];
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const c = useColors();
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[{ color: color ?? (muted ? c.textMuted : c.text), fontSize: size, fontWeight: weight }, style]}
    >
      {children}
    </Text>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
  small,
  color,
  ...rest
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  /** Overrides the accent color (border / background). */
  color?: string;
  style?: StyleProp<ViewStyle>;
} & Pick<PressableProps, "accessibilityLabel" | "testID">) {
  const c = useColors();
  const accent = color ?? (variant === "danger" ? c.danger : c.primary);
  const filled = variant === "primary" || variant === "danger";
  const bg = filled ? accent : variant === "secondary" ? c.cardAlt : "transparent";
  const fg = filled ? c.primaryText : variant === "ghost" ? accent : c.text;
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, borderColor: variant === "secondary" ? c.border : filled ? accent : "transparent" },
        color && variant === "secondary" ? { borderColor: color } : null,
        (pressed || inactive) && { opacity: inactive ? 0.45 : 0.75 },
        style,
      ]}
      {...rest}
    >
      {loading ? <ActivityIndicator color={fg} size="small" style={{ marginRight: 6 }} /> : null}
      <Text style={{ color: color && variant === "secondary" ? color : fg, fontWeight: "600", fontSize: small ? 13 : 15 }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Badge({ label, color, solid }: { label: string; color: string; solid?: boolean }) {
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: solid ? color : `${color}1F` }]}>
      <Text style={{ color: solid ? "#fff" : color, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Chip({
  label,
  sublabel,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={disabled ? undefined : onPress}
      style={[
        styles.chip,
        {
          borderColor: selected ? c.primary : c.border,
          backgroundColor: selected ? `${c.primary}1A` : c.card,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text style={{ color: selected ? c.primary : c.text, fontWeight: "600", fontSize: 14 }}>{label}</Text>
      {sublabel ? <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 2 }}>{sublabel}</Text> : null}
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.section, { color: c.textMuted }]}>{children}</Text>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.errorBanner, { borderColor: c.danger, backgroundColor: `${c.danger}14` }]}>
      <Text style={{ color: c.danger, flex: 1 }}>{message}</Text>
      {onRetry ? <Button title={t.common.retry} small variant="ghost" color={c.danger} onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Txt size={17} weight="600">
        {title}
      </Txt>
      {hint ? (
        <Txt muted style={{ textAlign: "center", marginTop: 8 }}>
          {hint}
        </Txt>
      ) : null}
      {children}
    </View>
  );
}

export function Row({ children, style, gap = 8 }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap }, style]}>{children}</View>;
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Loading() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  buttonSmall: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  section: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    marginTop: 20,
    marginBottom: 8,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
    marginBottom: 12,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    minHeight: 240,
  },
});
