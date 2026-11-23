import Ionicons from "@expo/vector-icons/Ionicons";
import type { Run, RunAction, RunStatus, Task, TaskDetail } from "@agentfleet/proto";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorMessage } from "@/api/client";
import { UnifiedDiffView } from "@/components/DiffView";
import { TaskStateBadge } from "@/components/TaskRow";
import { PlanChecklist, TimelineItemView, UsageChip } from "@/components/Timeline";
import { Badge, Button, Card, Chip, EmptyState, ErrorBanner, Loading, Row, Txt } from "@/components/ui";
import { t } from "@/i18n/strings";
import { alertMessage, confirmAsync, confirmDanger } from "@/lib/dialog";
import { useFleet } from "@/state/fleet";
import { usePaired } from "@/state/session";
import { pendingApprovals, type ApprovalItem, type TimelineItem } from "@/timeline/reduce";
import { useRunTimeline } from "@/timeline/useRunTimeline";
import { MONO, runStatusColor, useColors } from "@/theme";

const ACTIVE_RUN: ReadonlySet<RunStatus> = new Set(["starting", "running", "waiting_approval"]);
const CANCELLABLE: ReadonlySet<Task["state"]> = new Set(["queued", "assigned", "running", "waiting_approval"]);
const RETRYABLE: ReadonlySet<Task["state"]> = new Set(["failed", "cancelled"]);
const ACTIONS: RunAction[] = ["commit", "push", "pr", "discard"];

type Tab = "timeline" | "changes";

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { client, socket } = usePaired();
  const { nodeById, upsertTask } = useFleet();

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("timeline");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await client.getTask(id);
      setDetail(d);
      setLoadError(null);
      upsertTask(d.task);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [client, id, upsertTask]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live task/run updates.
  useEffect(
    () =>
      socket.addListeners({
        task: (task) => {
          if (task.id !== id) return;
          setDetail((d) => (d ? { ...d, task } : d));
        },
        run: (run) => {
          if (run.taskId !== id) return;
          setDetail((d) => {
            if (!d) return d;
            const idx = d.runs.findIndex((r) => r.id === run.id);
            const runs = idx >= 0 ? d.runs.map((r, i) => (i === idx ? run : r)) : [...d.runs, run];
            return { ...d, runs };
          });
        },
        open: (reconnect) => {
          if (reconnect) void load();
        },
      }),
    [socket, id, load],
  );

  const task = detail?.task ?? null;
  const runs = useMemo(() => (detail ? detail.runs.slice().sort((a, b) => a.startedAt - b.startedAt) : []), [detail]);

  // Follow the latest run (task.runId) unless the user picked an older attempt.
  const latestRunId = task?.runId ?? runs[runs.length - 1]?.id ?? null;
  const prevLatest = useRef<string | null>(null);
  useEffect(() => {
    if (latestRunId !== prevLatest.current) {
      setSelectedRunId((cur) => (cur === null || cur === prevLatest.current ? latestRunId : cur));
      prevLatest.current = latestRunId;
    }
  }, [latestRunId]);

  // A run referenced by task.runId may not be in `runs` yet (assigned moments ago).
  useEffect(() => {
    if (selectedRunId && detail && !detail.runs.some((r) => r.id === selectedRunId)) {
      client
        .getRun(selectedRunId)
        .then((run) => setDetail((d) => (d && !d.runs.some((r) => r.id === run.id) ? { ...d, runs: [...d.runs, run] } : d)))
        .catch(() => {});
    }
  }, [client, selectedRunId, detail]);

  const run: Run | null = runs.find((r) => r.id === selectedRunId) ?? null;
  const { timeline, loading: timelineLoading, error: timelineError, refresh: refreshTimeline } = useRunTimeline(
    client,
    socket,
    selectedRunId,
  );

  const node = run ? nodeById(run.nodeId) : undefined;
  const capability = run && node ? node.runtimes.find((r) => r.id === run.runtimeId) : undefined;
  const multiTurn = capability?.supports.includes("multiTurn") ?? false;
  const runActive =
    !!run && ACTIVE_RUN.has(run.status) && !(timeline.status && !ACTIVE_RUN.has(timeline.status));
  const pending = pendingApprovals(timeline);
  const isLatest = run?.id === latestRunId;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), refreshTimeline()]);
    setRefreshing(false);
  }, [load, refreshTimeline]);

  const onDecide = useCallback(
    async (item: ApprovalItem, optionId: string): Promise<boolean> => {
      if (!run) return false;
      const option = item.options.find((o) => o.id === optionId);
      const allowing = option?.kind.startsWith("allow") ?? false;
      if (item.risk === "danger" && allowing && !(await confirmDanger(item.title))) return false;
      try {
        await client.decideApproval(run.id, item.approvalId, optionId);
        return true;
      } catch (e) {
        alertMessage(t.common.error, errorMessage(e));
        return false;
      }
    },
    [client, run],
  );

  // --- auto-scroll: stick to the bottom while the user is near it ---------
  const listRef = useRef<FlatList<TimelineItem>>(null);
  const nearBottom = useRef(true);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 120;
  };
  const onContentSizeChange = () => {
    if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false });
  };
  const scrollToFirstPending = () => {
    const first = pending[0];
    if (!first) return;
    const index = timeline.items.indexOf(first);
    if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.1, animated: true });
  };

  if (!detail) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, padding: 16 }}>
        <Stack.Screen options={{ title: t.detail.title }} />
        {loadError ? <ErrorBanner message={loadError} onRetry={() => void load()} /> : <Loading />}
      </View>
    );
  }
  const theTask = detail.task;

  const header = (
    <View>
      {loadError ? <ErrorBanner message={loadError} onRetry={() => void load()} /> : null}
      <Card style={{ marginBottom: 10 }}>
        <Row style={{ alignItems: "flex-start" }}>
          <Txt weight="700" size={17} style={{ flex: 1 }} selectable>
            {theTask.title || theTask.prompt}
          </Txt>
          <TaskStateBadge state={theTask.state} />
        </Row>
        {theTask.note ? (
          <Txt muted size={13} style={{ marginTop: 6 }}>
            {theTask.note}
          </Txt>
        ) : null}
        <View style={styles.meta}>
          <Meta label={t.newTask.project} value={theTask.project} />
          <Meta label={t.detail.node} value={run ? node?.name ?? run.nodeId : "—"} />
          <Meta
            label={t.detail.runtime}
            value={run ? `${capability?.agent ?? run.runtimeId}${capability ? ` · ${t.tier[capability.tier]}` : ""}` : "—"}
          />
          {run?.branch ? <Meta label={t.detail.branch} value={run.branch} mono /> : null}
        </View>
        <Row style={{ marginTop: 8, flexWrap: "wrap" }}>
          {run ? <Badge label={t.runStatus[run.status]} color={runStatusColor(c, run.status)} /> : null}
          {timeline.usage ? <UsageChip usage={timeline.usage} /> : null}
        </Row>
        {run?.error ? (
          <Txt size={13} color={c.danger} style={{ marginTop: 8 }} selectable>
            {t.detail.error}: {run.error}
          </Txt>
        ) : null}
        <Txt muted size={13} style={{ marginTop: 10 }} numberOfLines={4} selectable>
          {theTask.prompt}
        </Txt>
      </Card>

      {runs.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 10 }}>
          {runs.map((r, i) => (
            <Chip
              key={r.id}
              label={`#${i + 1}`}
              sublabel={t.runStatus[r.status]}
              selected={r.id === selectedRunId}
              onPress={() => setSelectedRunId(r.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.segment, { backgroundColor: c.cardAlt }]}>
        <SegmentButton label={t.detail.timeline} active={tab === "timeline"} onPress={() => setTab("timeline")} />
        <SegmentButton
          label={
            timeline.diff
              ? `${t.detail.changes} +${timeline.diff.additions} −${timeline.diff.deletions}`
              : t.detail.changes
          }
          active={tab === "changes"}
          onPress={() => setTab("changes")}
        />
      </View>

      {pending.length > 0 && tab === "timeline" ? (
        <Pressable onPress={scrollToFirstPending} style={[styles.pendingBanner, { backgroundColor: c.warning }]}>
          <Ionicons name="hand-left" size={14} color="#fff" />
          <Txt color="#fff" weight="700" size={14}>
            {t.approval.title} ({pending.length})
          </Txt>
        </Pressable>
      ) : null}

      {timelineError ? <ErrorBanner message={timelineError} onRetry={() => void refreshTimeline()} /> : null}
      {tab === "timeline" && timeline.plan && timeline.plan.length > 0 ? <PlanChecklist entries={timeline.plan} /> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen options={{ title: theTask.title || t.detail.title }} />
      {tab === "timeline" ? (
        <FlatList
          ref={listRef}
          data={timeline.items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => <TimelineItemView item={item} canDecide={runActive && isLatest} onDecide={onDecide} />}
          ListHeaderComponent={header}
          ListEmptyComponent={
            timelineLoading ? <Loading /> : <EmptyState title={run ? t.detail.noEvents : t.detail.noRun} />
          }
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onScroll={onScroll}
          scrollEventThrottle={100}
          onContentSizeChange={onContentSizeChange}
          onScrollToIndexFailed={({ averageItemLength, index }) =>
            listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true })
          }
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {header}
          {timeline.diff ? (
            <>
              <Txt muted size={13}>
                {t.detail.files(timeline.diff.files)} · +{timeline.diff.additions} −{timeline.diff.deletions}
              </Txt>
              <UnifiedDiffView unified={timeline.diff.unified} />
            </>
          ) : (
            <EmptyState title={t.detail.noChanges} />
          )}
        </ScrollView>
      )}

      <BottomBar
        task={theTask}
        run={run}
        isLatest={isLatest}
        runActive={runActive}
        multiTurn={multiTurn}
        capabilityKnown={!!capability}
        bottomInset={insets.bottom}
        onChanged={load}
      />
    </KeyboardAvoidingView>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.metaItem}>
      <Txt muted size={12}>
        {label}
      </Txt>
      <Txt size={14} style={mono ? MONO : undefined} numberOfLines={1} selectable>
        {value}
      </Txt>
    </View>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.segmentBtn, active && { backgroundColor: c.card }]}
    >
      <Txt size={14} weight={active ? "700" : "500"} muted={!active}>
        {label}
      </Txt>
    </Pressable>
  );
}

/** Composer, interrupt, cancel/retry and post-run actions. */
function BottomBar({
  task,
  run,
  isLatest,
  runActive,
  multiTurn,
  capabilityKnown,
  bottomInset,
  onChanged,
}: {
  task: Task;
  run: Run | null;
  isLatest: boolean;
  runActive: boolean;
  multiTurn: boolean;
  capabilityKnown: boolean;
  bottomInset: number;
  onChanged: () => Promise<void>;
}) {
  const c = useColors();
  const { client } = usePaired();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const guard = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      alertMessage(t.common.error, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = () => {
    const body = text.trim();
    if (!run || !body) return;
    void guard("send", async () => {
      await client.sendInput(run.id, body);
      setText("");
    });
  };

  const interrupt = async () => {
    if (!run || !(await confirmAsync(t.detail.interrupt, t.detail.interruptConfirm, { destructive: true }))) return;
    void guard("interrupt", () => client.interrupt(run.id));
  };

  const cancelTask = async () => {
    if (!(await confirmAsync(t.detail.cancelTask, t.detail.cancelTaskConfirm, { destructive: true }))) return;
    void guard("cancel", () => client.cancelTask(task.id));
  };

  const runAction = async (action: RunAction) => {
    if (!run) return;
    if (action === "discard" && !(await confirmAsync(t.runAction.discard, t.detail.discardConfirm, { destructive: true })))
      return;
    void guard(action, async () => {
      const res = await client.runAction(run.id, action);
      const title = `${t.runAction[action]} · ${res.ok ? t.common.ok : t.common.error}`;
      if (res.url) {
        if (await confirmAsync(title, `${res.output}\n\n${res.url}`, { confirmText: t.detail.openLink })) {
          await Linking.openURL(res.url);
        }
      } else {
        alertMessage(title, res.output || undefined);
      }
    });
  };

  const inReview = task.state === "review";
  // Follow-ups are allowed while running and after completion (`review`): the
  // hub reopens the run.
  const showComposer = !!run && isLatest && (runActive || inReview);
  const canSend = showComposer && multiTurn;

  const hasButtons = (runActive && isLatest) || CANCELLABLE.has(task.state) || RETRYABLE.has(task.state) || (inReview && isLatest && run);
  if (!hasButtons && !showComposer) return null;

  return (
    <View style={[styles.bottom, { borderTopColor: c.border, backgroundColor: c.card, paddingBottom: 8 + bottomInset }]}>
      {inReview && isLatest && run ? (
        <View style={{ marginBottom: 8 }}>
          <Txt muted size={12} weight="600" style={{ marginBottom: 6 }}>
            {t.detail.actions}
          </Txt>
          <Row style={{ flexWrap: "wrap" }}>
            {ACTIONS.map((a) => (
              <Button
                key={a}
                small
                title={t.runAction[a]}
                variant={a === "discard" ? "secondary" : a === "pr" ? "primary" : "secondary"}
                color={a === "discard" ? c.danger : undefined}
                loading={busy === a}
                disabled={busy !== null && busy !== a}
                onPress={() => void runAction(a)}
              />
            ))}
          </Row>
        </View>
      ) : null}

      <Row style={{ flexWrap: "wrap", marginBottom: showComposer ? 8 : 0 }}>
        {runActive && isLatest ? (
          <Button small variant="secondary" color={c.warning} title={t.detail.interrupt} loading={busy === "interrupt"} onPress={() => void interrupt()} />
        ) : null}
        {CANCELLABLE.has(task.state) ? (
          <Button small variant="ghost" color={c.danger} title={t.detail.cancelTask} loading={busy === "cancel"} onPress={() => void cancelTask()} />
        ) : null}
        {RETRYABLE.has(task.state) ? (
          <Button
            small
            variant="secondary"
            title={t.detail.retryTask}
            loading={busy === "retry"}
            onPress={() => void guard("retry", () => client.retryTask(task.id))}
          />
        ) : null}
      </Row>

      {showComposer ? (
        canSend ? (
          <Row style={{ alignItems: "flex-end" }}>
            <TextInput
              style={[styles.composer, { color: c.text, borderColor: c.border, backgroundColor: c.bg }]}
              value={text}
              onChangeText={setText}
              placeholder={t.detail.composerPlaceholder}
              placeholderTextColor={c.textMuted}
              multiline
            />
            <Button title={t.detail.send} onPress={send} loading={busy === "send"} disabled={!text.trim()} />
          </Row>
        ) : capabilityKnown ? (
          <Txt muted size={12}>
            {t.detail.multiTurnUnsupported}
          </Txt>
        ) : null
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, paddingBottom: 24, flexGrow: 1 },
  meta: { flexDirection: "row", flexWrap: "wrap", marginTop: 10, rowGap: 8 },
  metaItem: { width: "50%", paddingRight: 8 },
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginBottom: 10 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
  pendingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  bottom: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 10 },
  composer: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 40,
  },
});
