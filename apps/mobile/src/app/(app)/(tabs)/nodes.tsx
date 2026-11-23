import { keyFingerprint, type Capability, type NodeInfo } from "@agentfleet/proto";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useCallback, useRef, useState } from "react";
import { FlatList, Modal, Platform, RefreshControl, StyleSheet, View } from "react-native";

import { Badge, Button, Card, Dot, EmptyState, ErrorBanner, Loading, Row, Txt } from "@/components/ui";
import { t } from "@/i18n/strings";
import { alertMessage, confirmAsync } from "@/lib/dialog";
import { parseNodeTrustQr } from "@/lib/e2eePure";
import { timeAgo } from "@/lib/format";
import { useE2EE } from "@/state/e2ee";
import { useFleet } from "@/state/fleet";
import { MONO, useColors, type Palette } from "@/theme";

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

function NodeCard({ node, onScan }: { node: NodeInfo; onScan: (node: NodeInfo) => void }) {
  const c = useColors();
  const { trustStatus, trustNode, untrustNode } = useE2EE();
  const status = trustStatus(node);
  const fp = node.publicKey ? keyFingerprint(node.publicKey) : null;

  const badge = {
    trusted: { label: t.e2ee.statusTrusted, color: c.success },
    unverified: { label: t.e2ee.statusUnverified, color: c.warning },
    mismatch: { label: t.e2ee.statusMismatch, color: c.danger },
    "no-key": { label: t.e2ee.statusNoKey, color: c.textMuted },
  }[status];

  const onManualTrust = async () => {
    if (!node.publicKey || !fp) return;
    const ok = await confirmAsync(t.e2ee.trustConfirmTitle, t.e2ee.trustConfirmBody(node.name, fp), {
      destructive: status === "mismatch",
    });
    if (ok) await trustNode(node.id, node.publicKey, "manual");
  };

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

      <View style={[styles.e2eeBox, { borderTopColor: c.border }]}>
        <Row style={{ flexWrap: "wrap" }} gap={8}>
          <Badge label={badge.label} color={badge.color} solid={status === "mismatch"} />
          {fp ? (
            <Txt muted size={12} style={MONO} selectable>
              {t.e2ee.fingerprint(fp)}
            </Txt>
          ) : null}
        </Row>
        {status === "mismatch" ? (
          <Txt size={12} color={c.danger} style={{ marginTop: 6 }}>
            {t.e2ee.mismatchAlert}
          </Txt>
        ) : null}
        {node.publicKey ? (
          <Row style={{ marginTop: 8, flexWrap: "wrap" }} gap={8}>
            {status !== "trusted" && Platform.OS !== "web" ? (
              <Button title={t.e2ee.scanVerify} onPress={() => onScan(node)} />
            ) : null}
            {status !== "trusted" ? (
              <Button title={t.e2ee.trustManual} variant="secondary" onPress={() => void onManualTrust()} />
            ) : (
              <Button title={t.e2ee.untrust} variant="secondary" onPress={() => void untrustNode(node.id)} />
            )}
          </Row>
        ) : null}
      </View>

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
  const { trustNode } = useE2EE();
  const [refreshing, setRefreshing] = useState(false);
  const [scanTarget, setScanTarget] = useState<NodeInfo | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshNodes();
    setRefreshing(false);
  }, [refreshNodes]);

  const startScan = async (node: NodeInfo) => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    scannedRef.current = false;
    setScanTarget(node);
  };

  const onBarcode = async (res: BarcodeScanningResult) => {
    if (scannedRef.current || !scanTarget) return;
    scannedRef.current = true;
    const payload = parseNodeTrustQr(res.data);
    const target = scanTarget;
    setScanTarget(null);
    if (!payload) {
      alertMessage(t.common.error, t.e2ee.qrInvalid);
      return;
    }
    if (payload.nodeId !== target.id) {
      alertMessage(t.common.error, t.e2ee.qrWrongNode(target.name, payload.name));
      return;
    }
    await trustNode(payload.nodeId, payload.publicKey, "qr");
    alertMessage(t.common.ok, t.e2ee.qrSuccess(payload.name, keyFingerprint(payload.publicKey)));
  };

  if (!nodes.loaded && nodes.loading) return <Loading />;
  const sorted = nodes.data.slice().sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return (
    <>
      <FlatList
        style={{ backgroundColor: c.bg }}
        data={sorted}
        keyExtractor={(n) => n.id}
        renderItem={({ item }) => <NodeCard node={item} onScan={(n) => void startScan(n)} />}
        contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={nodes.error ? <ErrorBanner message={nodes.error} onRetry={onRefresh} /> : undefined}
        ListEmptyComponent={nodes.error ? undefined : <EmptyState title={t.nodes.empty} hint={t.nodes.emptyHint} />}
      />

      <Modal visible={!!scanTarget} animationType="slide" onRequestClose={() => setScanTarget(null)}>
        <View style={[styles.modal, { backgroundColor: c.bg }]}>
          <Txt weight="700" size={18}>
            {t.e2ee.qrTitle}
          </Txt>
          <Txt muted size={13} style={{ marginTop: 4, marginBottom: 12 }}>
            {t.e2ee.qrHint}
          </Txt>
          <View style={styles.cameraWrap}>
            {scanTarget ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(r) => void onBarcode(r)}
              />
            ) : null}
          </View>
          <View style={{ marginTop: 16 }}>
            <Button title={t.common.cancel} variant="secondary" onPress={() => setScanTarget(null)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {},
  e2eeBox: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginTop: 10 },
  runtime: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, marginTop: 8 },
  modal: { flex: 1, padding: 20, justifyContent: "center" },
  cameraWrap: { height: 320, borderRadius: 14, overflow: "hidden", backgroundColor: "#000" },
});
