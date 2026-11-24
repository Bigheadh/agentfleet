import { router, Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { ConnectionPill } from "@/components/ConnectionPill";
import { TaskRow } from "@/components/TaskRow";
import { Button, Chip, EmptyState, ErrorBanner, Loading } from "@/components/ui";
import { t } from "@/i18n/strings";
import { countTasksByFilter, filterTasks, type TaskFilter } from "@/lib/taskFilter";
import { useE2EE } from "@/state/e2ee";
import { useFleet } from "@/state/fleet";
import { useColors } from "@/theme";

const FILTERS: TaskFilter[] = ["all", "waiting_approval", "active", "review", "ended"];

export default function TasksScreen() {
  const c = useColors();
  const { tasks, refreshTasks } = useFleet();
  const { decryptTask } = useE2EE();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshTasks();
    setRefreshing(false);
  }, [refreshTasks]);

  const counts = useMemo(() => countTasksByFilter(tasks.data), [tasks.data]);
  const visible = useMemo(
    () => filterTasks(tasks.data, filter, query, (task) => decryptTask(task).task.title),
    [tasks.data, filter, query, decryptTask],
  );
  const hasFilter = filter !== "all" || query.trim().length > 0;

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <Stack.Screen
        options={{
          headerLeft: () => <ConnectionPill />,
          headerRight: () => (
            <Button small title={`＋ ${t.tasks.newTask}`} onPress={() => router.push("/tasks/new")} style={{ marginRight: 12 }} />
          ),
        }}
      />
      {!tasks.loaded && tasks.loading ? (
        <Loading />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(task) => task.id}
          renderItem={({ item }) => <TaskRow task={item} onPress={() => router.push(`/tasks/${item.id}`)} />}
          contentContainerStyle={{ paddingBottom: 16, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={
            <View style={styles.header}>
              {tasks.error ? <ErrorBanner message={tasks.error} onRetry={onRefresh} /> : null}
              {tasks.data.length > 0 ? (
                <>
                  <TextInput
                    style={[styles.search, { color: c.text, borderColor: c.border, backgroundColor: c.card }]}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t.filter.searchPlaceholder}
                    placeholderTextColor={c.textMuted}
                    clearButtonMode="while-editing"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.filters}
                  >
                    {FILTERS.map((f) => {
                      const n = counts[f];
                      const label = f === "all" || n === 0 ? t.filter[f] : `${t.filter[f]} ${n}`;
                      return <Chip key={f} label={label} selected={filter === f} onPress={() => setFilter(f)} />;
                    })}
                  </ScrollView>
                </>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            tasks.error ? undefined : hasFilter ? (
              <EmptyState title={t.filter.noMatches}>
                <Button
                  title={t.filter.all}
                  variant="secondary"
                  onPress={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                  style={{ marginTop: 12 }}
                />
              </EmptyState>
            ) : (
              <EmptyState title={t.tasks.empty} hint={t.tasks.emptyHint}>
                <Button title={t.tasks.newTask} onPress={() => router.push("/tasks/new")} style={{ marginTop: 16 }} />
              </EmptyState>
            )
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingTop: 10, paddingBottom: 4, gap: 8 },
  search: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  filters: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
});
