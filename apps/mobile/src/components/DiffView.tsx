/** Monospace diff viewer with +/- line coloring. No syntax highlighting (keeps deps at zero). */
import type { FileDiff } from "@agentfleet/proto";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { t } from "../i18n/strings";
import { classifyUnified, fileDiffLines, type DiffLine } from "../lib/diff";
import { MONO, useColors, type Palette } from "../theme";
import { Button } from "./ui";

const PAGE = 300;

function lineStyle(c: Palette, kind: DiffLine["kind"]) {
  switch (kind) {
    case "add":
      return { color: c.diffAddText, backgroundColor: c.diffAddBg };
    case "del":
      return { color: c.diffDelText, backgroundColor: c.diffDelBg };
    case "hunk":
      return { color: c.diffHunkText, backgroundColor: c.diffHunkBg };
    case "file":
      return { color: c.text, backgroundColor: c.cardAlt, fontWeight: "700" as const };
    case "meta":
      return { color: c.textMuted };
    case "ctx":
      return { color: c.text };
  }
}

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  const c = useColors();
  const [limit, setLimit] = useState(PAGE);
  // minWidth: "100%" doesn't work inside a horizontal ScrollView, so measure it
  // to let the +/- backgrounds span the full width for short lines.
  const [width, setWidth] = useState(0);
  const shown = lines.length > limit ? lines.slice(0, limit) : lines;
  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.card }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={[styles.inner, width > 0 && { minWidth: width }]}>
          {shown.map((l, i) => (
            <Text key={i} selectable style={[styles.line, MONO, lineStyle(c, l.kind)]}>
              {l.text === "" ? " " : l.text}
            </Text>
          ))}
        </View>
      </ScrollView>
      {lines.length > limit ? (
        <Button
          small
          variant="ghost"
          title={`${t.common.showMore} (${lines.length - limit})`}
          onPress={() => setLimit((n) => n + PAGE)}
        />
      ) : null}
    </View>
  );
}

export function UnifiedDiffView({ unified }: { unified: string }) {
  const lines = useMemo(() => classifyUnified(unified), [unified]);
  return <DiffLines lines={lines} />;
}

export function FileDiffsView({ diffs }: { diffs: FileDiff[] }) {
  const lines = useMemo(() => diffs.flatMap((d) => fileDiffLines(d)), [diffs]);
  if (lines.length === 0) return null;
  return <DiffLines lines={lines} />;
}

const styles = StyleSheet.create({
  box: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: "hidden",
    marginTop: 8,
  },
  inner: {
    paddingVertical: 4,
  },
  line: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 8,
  },
});
