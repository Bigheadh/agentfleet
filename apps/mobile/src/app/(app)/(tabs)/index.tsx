import { router, Stack } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { ConnectionPill } from "@/components/ConnectionPill";
import { TaskRow } from "@/components/TaskRow";
import { Button, EmptyState, ErrorBanner, Loading } from "@/components/ui";
import { t } from "@/i18n/strings";
import { useFleet } from "@/state/fleet";
import { useColors } from "@/theme";

export default function TasksScreen() {
  const c = useColors();
  const { tasks, refreshTasks } = useFleet();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshTasks();
    setRefreshing(false);
  }, [refreshTasks]);

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
          data={tasks.data}
          keyExtractor={(task) => task.id}
          renderItem={({ item }) => <TaskRow task={item} onPress={() => router.push(`/tasks/${item.id}`)} />}
          contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={
            tasks.error ? (
              <View style={{ paddingHorizontal: 16 }}>
                <ErrorBanner message={tasks.error} onRetry={onRefresh} />
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            tasks.error ? undefined : (
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

const styles = StyleSheet.create({ flex: { flex: 1 } });
