import { Platform, useColorScheme } from "react-native";
import type { Risk, RunStatus, TaskState } from "@agentfleet/proto";

const light = {
  bg: "#F4F5F7",
  card: "#FFFFFF",
  cardAlt: "#F0F1F4",
  border: "#E1E3E8",
  text: "#111318",
  textMuted: "#60646C",
  primary: "#2563EB",
  primaryText: "#FFFFFF",
  danger: "#DC2626",
  warning: "#D97706",
  success: "#16A34A",
  info: "#0891B2",
  bubbleUser: "#2563EB",
  bubbleUserText: "#FFFFFF",
  bubbleAgent: "#FFFFFF",
  codeBg: "#0F172A",
  codeText: "#E2E8F0",
  diffAddBg: "#E6FFEC",
  diffAddText: "#116329",
  diffDelBg: "#FFEBE9",
  diffDelText: "#A40E26",
  diffHunkText: "#0550AE",
  diffHunkBg: "#DDF4FF",
};

export type Palette = typeof light;

const dark: Palette = {
  bg: "#0B0C0F",
  card: "#17181C",
  cardAlt: "#212328",
  border: "#2C2E34",
  text: "#F2F3F5",
  textMuted: "#A0A4AB",
  primary: "#3B82F6",
  primaryText: "#FFFFFF",
  danger: "#F87171",
  warning: "#FBBF24",
  success: "#4ADE80",
  info: "#22D3EE",
  bubbleUser: "#2563EB",
  bubbleUserText: "#FFFFFF",
  bubbleAgent: "#17181C",
  codeBg: "#05070C",
  codeText: "#E2E8F0",
  diffAddBg: "#12261A",
  diffAddText: "#7EE2A8",
  diffDelBg: "#2D1418",
  diffDelText: "#FF9DA4",
  diffHunkText: "#79C0FF",
  diffHunkBg: "#0C2D4A",
};

export function useColors(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export const MONO = {
  fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" }),
} as const;

export function taskStateColor(c: Palette, s: TaskState): string {
  switch (s) {
    case "queued":
    case "assigned":
      return c.textMuted;
    case "running":
      return c.primary;
    case "waiting_approval":
      return c.warning;
    case "review":
      return c.info;
    case "done":
      return c.success;
    case "failed":
      return c.danger;
    case "cancelled":
      return c.textMuted;
  }
}

export function runStatusColor(c: Palette, s: RunStatus): string {
  switch (s) {
    case "starting":
    case "running":
      return c.primary;
    case "waiting_approval":
      return c.warning;
    case "completed":
      return c.success;
    case "failed":
      return c.danger;
    case "interrupted":
      return c.textMuted;
  }
}

export function riskColor(c: Palette, r: Risk): string {
  switch (r) {
    case "read":
      return c.success;
    case "write":
      return c.info;
    case "exec":
      return c.warning;
    case "danger":
      return c.danger;
  }
}
