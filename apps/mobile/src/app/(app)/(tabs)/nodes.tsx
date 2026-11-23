import type { Capability, NodeInfo } from "@agentfleet/proto";
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { Badge, Card, Dot, EmptyState, ErrorBanner, Loading, Row, Txt } from "@/components/ui";
import { t } from "@/i18n/strings";
import { timeAgo } from "@/lib/format";
import { useFleet } from "@/state/fleet";
import { useColors, type Palette } from "@/theme";

function loginLabel(rt: Capability): { label: string; color: (c: Palette) => string } {
  if (!rt.installed) return { label: t.newTask.notInstalled, color: (c) => c.danger };
  if (rt.loggedIn === true) return { label: t.newTask.loggedIn, color: (c) => c.success };
  if (rt.loggedIn === false) return { label: t.newTask.notLoggedIn, color: (c) => c.danger };
  return { label: t.newTask.loginUnknown, color: (c) => c.textMuted };
}

function RuntimeRow({ rt }: { rt: Capability }) {
  const c = useColors();
  const login = loginLabel(rt);
  return (
    <View style={[styles.runtime, { borderTopColor: c.border }]}>
      <Row>
        <Txt weight="600" style={{ flex: 1 }} numberOfLines={1}>
          {rt.agent} <Txt muted size={12}>{rt.id}</Txt>
        </Txt>
        <Badge label={t.tier[rt.tier]} color={c.info} />
        <Badge label={login.label} color={login.color(c)} />
      </Row>
      <Txt muted size={12} style={{ marginTop: 2 }}>
        {[rt.version, rt.supports.length ? rt.supports.join(", ") : null].filter(Boolean).join(" · ")}
      </Txt>
      {rt.note ? (
        <Txt size={12} color={c.warning} style={{ marginTop: 2 }}>
          {rt.note}
        </Txt>
      ) : null}
    </View>
  );
}

function NodeCard({ node }: { node: NodeInfo }) {
  const c = useColors();
  return (
    <Card style={styles.card}>
      <Row>
        <Dot color={node.online ? c.success : c.textMuted} size={10} />
        <Txt weight="700" size={16} style={{ flex: 1 }} numberOfLines={1}>
          {node.name}
        </Txt>
        <Txt muted size={13}>
          {node.online ? t.nodes.online : t.nodes.offline}
        </Txt>
      </Row>
      <Txt muted size={13} style={{ marginTop: 4 }}>
        {[
          node.os,
          t.nodes.running(node.running, node.maxConcurrency),
          t.nodes.projects(node.projects.length),
          node.online ? null : t.nodes.lastSeen(timeAgo(node.lastSeen)),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Txt>
      {node.labels.length > 0 ? (
        <Row style={{ flexWrap: "wrap", marginTop: 8 }} gap={6}>
          {node.labels.map((l) => (
            <Badge key={l} label={l} color={c.textMuted} />
          ))}
        </Row>
      ) : null}
      <Txt muted size={12} weight="600" style={{ marginTop: 12 }}>
        {t.nodes.runtimes}
      </Txt>
      {node.runtimes.length === 0 ? (
        <Txt muted size={13} style={{ marginTop: 6 }}>
          {t.nodes.noRuntimes}
        </Txt>
      ) : (
        node.runtimes.map((rt) => <RuntimeRow key={rt.id} rt={rt} />)
      )}
    </Card>
  );
}

export default function NodesScreen() {
  const c = useColors();
  const { nodes, refreshNodes } = useFleet();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshNodes();
    setRefreshing(false);
  }, [refreshNodes]);

  if (!nodes.loaded && nodes.loading) return <Loading />;
  const sorted = nodes.data.slice().sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return (
    <FlatList
      style={{ backgroundColor: c.bg }}
      data={sorted}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => <NodeCard node={item} />}
      contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={nodes.error ? <ErrorBanner message={nodes.error} onRetry={onRefresh} /> : undefined}
      ListEmptyComponent={nodes.error ? undefined : <EmptyState title={t.nodes.empty} hint={t.nodes.emptyHint} />}
    />
  );
}

const styles = StyleSheet.create({
  card: {},
  runtime: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, marginTop: 8 },
});
