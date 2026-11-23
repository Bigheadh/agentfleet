import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router/js-tabs";

import { t } from "@/i18n/strings";
import { useFleet } from "@/state/fleet";

export default function TabsLayout() {
  const { waitingApproval } = useFleet();
  return (
    <Tabs screenOptions={{ headerShown: true }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.tasks,
          tabBarBadge: waitingApproval > 0 ? waitingApproval : undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="list" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="nodes"
        options={{
          title: t.tabs.nodes,
          tabBarIcon: ({ color, size }) => <Ionicons name="server-outline" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t.tabs.settings,
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
