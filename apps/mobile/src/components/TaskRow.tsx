import type { Task } from "@agentfleet/proto";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { t } from "../i18n/strings";
import { agentLabel, timeAgo } from "../lib/format";
import { taskStateColor, useColors } from "../theme";
import { Badge, Row, Txt } from "./ui";

export function TaskStateBadge({ state }: { state: Task["state"] }) {
  const c = useColors();
  return <Badge label={t.taskState[state]} color={taskStateColor(c, state)} solid={state === "waiting_approval"} />;
}

export const TaskRow = memo(function TaskRow({ task, onPress }: { task: Task; onPress: () => void }) {
  const c = useColors();
  const waiting = task.state === "waiting_approval";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: c.card, borderColor: waiting ? c.warning : c.border, borderWidth: waiting ? 1.5 : StyleSheet.hairlineWidth },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Row style={{ alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <Txt weight="600" numberOfLines={2}>
            {task.title || task.prompt}
          </Txt>
          <Txt muted size={13} style={{ marginTop: 4 }} numberOfLines={1}>
            {task.project} · {agentLabel(task.constraints.agent)} · {timeAgo(task.updatedAt)}
          </Txt>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <TaskStateBadge state={task.state} />
          {task.priority === "high" ? (
            <Txt size={12} color={c.danger}>
              {t.priority.high}
            </Txt>
          ) : null}
        </View>
      </Row>
      {task.note ? (
        <Txt muted size={12} style={{ marginTop: 6 }} numberOfLines={2}>
          {task.note}
        </Txt>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 5,
  },
});
