/** Renderers for timeline items produced by `timeline/reduce.ts`. */
import Ionicons from "@expo/vector-icons/Ionicons";
import type { PlanEntry, ToolKind, ToolStatus } from "@agentfleet/proto";
import { memo, useState, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { t } from "../i18n/strings";
import { formatCount } from "../lib/format";
import type {
  ApprovalItem,
  LogItem,
  MessageItem,
  ReasoningItem,
  StatusItem,
  TimelineItem,
  ToolItem,
  Usage,
} from "../timeline/reduce";
import { MONO, riskColor, runStatusColor, useColors, type Palette } from "../theme";
import { FileDiffsView } from "./DiffView";
import { Badge, Button, Card, Row, Txt } from "./ui";

type IconName = ComponentProps<typeof Ionicons>["name"];

const TOOL_ICONS: Record<ToolKind, IconName> = {
  read: "document-text-outline",
  edit: "create-outline",
  delete: "trash-outline",
  move: "swap-horizontal-outline",
  search: "search-outline",
  execute: "terminal-outline",
  think: "bulb-outline",
  fetch: "cloud-download-outline",
  switch_mode: "options-outline",
  other: "construct-outline",
};

function toolStatusColor(c: Palette, s: ToolStatus): string {
  return s === "completed" ? c.success : s === "failed" ? c.danger : s === "in_progress" ? c.primary : c.textMuted;
}

/** Long outputs are truncated to their tail when collapsed-expanded to keep rendering cheap. */
const MAX_OUTPUT_CHARS = 20_000;

export const MessageBubble = memo(function MessageBubble({ item }: { item: MessageItem }) {
  const c = useColors();
  const user = item.role === "user";
  return (
    <View style={[styles.bubbleRow, { justifyContent: user ? "flex-end" : "flex-start" }]}>
      <View
        style={[
          styles.bubble,
          user
            ? { backgroundColor: c.bubbleUser, borderBottomRightRadius: 4 }
            : { backgroundColor: c.bubbleAgent, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 4 },
        ]}
      >
        <Text selectable style={{ color: user ? c.bubbleUserText : c.text, fontSize: 15, lineHeight: 21 }}>
          {item.text}
        </Text>
      </View>
    </View>
  );
});

export const ReasoningBlock = memo(function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((o) => !o)} style={[styles.reasoning, { borderLeftColor: c.border }]}>
      <Row gap={6}>
        <Ionicons name="bulb-outline" size={14} color={c.textMuted} />
        <Txt muted size={13} weight="600">
          {t.detail.reasoning}
        </Txt>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={c.textMuted} />
      </Row>
      <Text
        selectable={open}
        numberOfLines={open ? undefined : 2}
        style={{ color: c.textMuted, fontSize: 13, fontStyle: "italic", marginTop: 4, lineHeight: 18 }}
      >
        {item.text}
      </Text>
    </Pressable>
  );
});

export const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const color = toolStatusColor(c, item.status);
  const hasBody = item.output.length > 0 || item.diffs.length > 0 || item.input !== undefined;
  const output = item.output.length > MAX_OUTPUT_CHARS ? `…${item.output.slice(-MAX_OUTPUT_CHARS)}` : item.output;
  return (
    <Card style={styles.toolCard}>
      <Pressable onPress={() => hasBody && setOpen((o) => !o)}>
        <Row>
          <Ionicons name={TOOL_ICONS[item.toolKind]} size={18} color={c.textMuted} />
          <Txt weight="600" style={{ flex: 1 }} numberOfLines={open ? undefined : 2}>
            {item.title}
          </Txt>
          {item.status === "in_progress" ? <ActivityIndicator size="small" color={color} /> : null}
          <Badge label={t.toolStatus[item.status]} color={color} />
          {hasBody ? <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={c.textMuted} /> : null}
        </Row>
        <Row style={{ marginTop: 4 }}>
          <Txt muted size={12}>
            {t.toolKind[item.toolKind]}
          </Txt>
          {item.exitCode != null ? (
            <Txt size={12} color={item.exitCode === 0 ? c.success : c.danger}>
              {t.detail.exitCode(item.exitCode)}
            </Txt>
          ) : null}
          {item.diffs.length > 0 ? (
            <Txt muted size={12}>
              {t.detail.files(item.diffs.length)}
            </Txt>
          ) : null}
        </Row>
      </Pressable>
      {open ? (
        <View>
          {item.input !== undefined ? <CodeBlock text={stringify(item.input)} /> : null}
          {output ? <CodeBlock text={output} /> : null}
          {item.diffs.length > 0 ? <FileDiffsView diffs={item.diffs} /> : null}
        </View>
      ) : null}
    </Card>
  );
});

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function CodeBlock({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={[styles.code, { backgroundColor: c.codeBg }]}>
      <Text selectable style={[MONO, { color: c.codeText, fontSize: 12, lineHeight: 17 }]}>
        {text}
      </Text>
    </View>
  );
}

export function ApprovalCard({
  item,
  canDecide,
  onDecide,
}: {
  item: ApprovalItem;
  /** false once the run has ended; buttons are hidden. */
  canDecide: boolean;
  onDecide: (item: ApprovalItem, optionId: string) => Promise<boolean>;
}) {
  const c = useColors();
  const [busy, setBusy] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const accent = riskColor(c, item.risk);
  const resolved = item.resolution;

  const decide = async (optionId: string) => {
    setBusy(optionId);
    try {
      const ok = await onDecide(item, optionId);
      if (ok) setSubmitted(true);
    } finally {
      setBusy(null);
    }
  };

  const chosen = resolved?.optionId ? item.options.find((o) => o.id === resolved.optionId)?.label ?? resolved.optionId : null;

  return (
    <Card style={[styles.approval, { borderColor: accent, borderWidth: resolved ? StyleSheet.hairlineWidth : 1.5 }]}>
      <Row>
        <Ionicons name={item.risk === "danger" ? "warning" : "shield-checkmark-outline"} size={18} color={accent} />
        <Txt weight="700" style={{ flex: 1 }}>
          {resolved ? t.approval.resolved : t.approval.title}
        </Txt>
        <Badge label={t.risk[item.risk]} color={accent} solid={item.risk === "danger"} />
      </Row>
      <Txt style={{ marginTop: 8 }} weight="600" selectable>
        {item.title}
      </Txt>
      {item.reason ? (
        <Txt muted size={13} style={{ marginTop: 4 }}>
          {t.approval.reason}: {item.reason}
        </Txt>
      ) : null}
      {item.command ? (
        <>
          <Txt muted size={12} style={{ marginTop: 8 }}>
            {t.approval.command}
          </Txt>
          <CodeBlock text={item.command} />
        </>
      ) : null}
      {item.cwd ? (
        <Txt muted size={12} style={[MONO, { marginTop: 6 }]} selectable>
          {t.approval.cwd}: {item.cwd}
        </Txt>
      ) : null}
      {item.diffs.length > 0 ? <FileDiffsView diffs={item.diffs} /> : null}

      {resolved ? (
        <Txt muted size={13} style={{ marginTop: 10 }}>
          {t.approval.resolvedBy[resolved.by]}
          {chosen ? ` · ${t.approval.chose(chosen)}` : ""}
        </Txt>
      ) : !canDecide ? (
        <Txt muted size={13} style={{ marginTop: 10 }}>
          {t.approval.runEnded}
        </Txt>
      ) : submitted ? (
        <Row style={{ marginTop: 10 }}>
          <ActivityIndicator size="small" />
          <Txt muted size={13}>
            {t.approval.submitted}
          </Txt>
        </Row>
      ) : (
        <View style={styles.options}>
          {item.options.map((o) => {
            const allow = o.kind.startsWith("allow");
            return (
              <Button
                key={o.id}
                title={o.label}
                small
                variant={allow ? (item.risk === "danger" ? "danger" : "primary") : "secondary"}
                loading={busy === o.id}
                disabled={busy !== null && busy !== o.id}
                onPress={() => void decide(o.id)}
                style={styles.optionBtn}
              />
            );
          })}
        </View>
      )}
    </Card>
  );
}

export const StatusLine = memo(function StatusLine({ item }: { item: StatusItem }) {
  const c = useColors();
  const color = runStatusColor(c, item.status);
  return (
    <View style={styles.status}>
      <View style={[styles.statusRule, { backgroundColor: c.border }]} />
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>
        {t.runStatus[item.status]}
        {item.detail ? ` · ${item.detail}` : ""}
      </Text>
      <View style={[styles.statusRule, { backgroundColor: c.border }]} />
    </View>
  );
});

export const LogLine = memo(function LogLine({ item }: { item: LogItem }) {
  const c = useColors();
  const color = item.level === "error" ? c.danger : item.level === "warn" ? c.warning : c.textMuted;
  return (
    <Text selectable style={[MONO, { color, fontSize: 11, marginVertical: 2 }]}>
      [{item.level}] {item.text}
    </Text>
  );
});

export function PlanChecklist({ entries }: { entries: PlanEntry[] }) {
  const c = useColors();
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <Card style={{ marginBottom: 10 }}>
      <Row style={{ marginBottom: 6 }}>
        <Ionicons name="list-outline" size={16} color={c.textMuted} />
        <Txt weight="600" style={{ flex: 1 }}>
          {t.detail.plan}
        </Txt>
        <Txt muted size={12}>
          {done}/{entries.length}
        </Txt>
      </Row>
      {entries.map((e, i) => (
        <Row key={i} style={{ marginVertical: 3, alignItems: "flex-start" }}>
          <Ionicons
            name={e.status === "completed" ? "checkmark-circle" : e.status === "in_progress" ? "ellipse-outline" : "ellipse-outline"}
            size={16}
            color={e.status === "completed" ? c.success : e.status === "in_progress" ? c.primary : c.textMuted}
          />
          <Txt
            size={14}
            muted={e.status === "completed"}
            weight={e.status === "in_progress" ? "600" : undefined}
            style={[{ flex: 1 }, e.status === "completed" && { textDecorationLine: "line-through" }]}
          >
            {e.content}
          </Txt>
        </Row>
      ))}
    </Card>
  );
}

export function UsageChip({ usage }: { usage: Usage }) {
  const c = useColors();
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const parts: string[] = [];
  if (total !== undefined) parts.push(t.detail.tokens(formatCount(total)));
  if (usage.contextUsed !== undefined && usage.contextSize)
    parts.push(t.detail.context(formatCount(usage.contextUsed), formatCount(usage.contextSize)));
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
  if (parts.length === 0) return null;
  return (
    <View style={[styles.usage, { backgroundColor: c.cardAlt }]}>
      <Ionicons name="speedometer-outline" size={12} color={c.textMuted} />
      <Text style={{ color: c.textMuted, fontSize: 12 }}>{parts.join(" · ")}</Text>
    </View>
  );
}

export function TimelineItemView({
  item,
  canDecide,
  onDecide,
}: {
  item: TimelineItem;
  canDecide: boolean;
  onDecide: (item: ApprovalItem, optionId: string) => Promise<boolean>;
}) {
  switch (item.kind) {
    case "message":
      return <MessageBubble item={item} />;
    case "reasoning":
      return <ReasoningBlock item={item} />;
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} canDecide={canDecide} onDecide={onDecide} />;
    case "status":
      return <StatusLine item={item} />;
    case "log":
      return item.level === "debug" ? null : <LogLine item={item} />;
  }
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: "row", marginVertical: 4 },
  bubble: { maxWidth: "88%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  reasoning: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 6 },
  toolCard: { marginVertical: 4, padding: 12 },
  code: { borderRadius: 8, padding: 10, marginTop: 8 },
  approval: { marginVertical: 6 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  optionBtn: { flexGrow: 1 },
  status: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 8 },
  statusRule: { flex: 1, height: StyleSheet.hairlineWidth },
  usage: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
});
