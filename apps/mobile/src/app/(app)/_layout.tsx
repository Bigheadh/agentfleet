import { Redirect, Stack } from "expo-router";

import { t } from "@/i18n/strings";
import { FleetProvider } from "@/state/fleet";
import { useSession } from "@/state/session";

/** Everything under (app) requires a paired hub. */
export default function AppLayout() {
  const { session, client, socket } = useSession();
  if (!session || !client || !socket) return <Redirect href="/pair" />;
  return (
    <FleetProvider key={session.token} client={client} socket={socket}>
      <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="tasks/new" options={{ title: t.newTask.title, presentation: "modal" }} />
        <Stack.Screen name="tasks/[id]" options={{ title: t.detail.title }} />
      </Stack>
    </FleetProvider>
  );
}
