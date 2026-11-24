/** Paired devices management (one-tap revoke) + audit log viewer on Settings screen. */
import { keyFingerprint, type AuditEntry, type DeviceInfo } from "@agentfleet/proto";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { errorMessage, type HubClient } from "../api/client";
import { t } from "../i18n/strings";
import { alertMessage, confirmAsync } from "../lib/dialog";
import { timeAgo } from "../lib/format";
import { MONO, useColors } from "../theme";
import { Badge, Button, Card, ErrorBanner, Row, SectionTitle, Txt } from "./ui";

export function DevicesAndAudit({ client }: { client: HubClient }) {
  const c = useColors();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [devError, setDevError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setDevError(null);
    try {
      setDevices(await client.listDevices());
    } catch (e) {
      setDevError(errorMessage(e));
    }
  }, [client]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      setAudit(await client.listAudit(50));
    } catch (e) {
      setAuditError(errorMessage(e));
    } finally {
      setAuditLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const onRevoke = async (dev: DeviceInfo) => {
    if (!(await confirmAsync(t.mgmt.revoke, t.mgmt.revokeConfirm(dev.name), { destructive: true, confirmText: t.mgmt.revoke }))) {
      return;
    }
    setRevoking(dev.id);
    try {
      await client.revokeDevice(dev.id);
      await loadDevices();
      if (auditOpen) await loadAudit();
    } catch (e) {
      alertMessage(t.common.error, errorMessage(e));
    } finally {
      setRevoking(null);
    }
  };

  const toggleAudit = () => {
    const next = !auditOpen;
    setAuditOpen(next);
    if (next) void loadAudit();
  };

  return (
    <>
      <SectionTitle>{t.mgmt.devicesTitle}</SectionTitle>
      {devError ? <ErrorBanner message={devError} onRetry={() => void loadDevices()} /> : null}
      <Card style={{ paddingVertical: 4 }}>
        {devices.length === 0 ? (
          <Txt muted size={13} style={{ paddingVertical: 8 }}>
            -
          </Txt>
        ) : (
          devices.map((d, idx) => (
            <View
              key={d.id}
              style={[
                styles.row,
                { borderBottomColor: c.border },
                idx === devices.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Row gap={6} style={{ flexWrap: "wrap" }}>
                  <Txt weight="600" size={14}>
                    {d.name}
                  </Txt>
                  {d.current ? <Badge label={t.mgmt.thisDevice} color={c.primary} /> : null}
                  {d.hasPush ? <Badge label="Push" color={c.success} /> : null}
                </Row>
                <Txt muted size={12} style={MONO}>
                  {[
                    d.publicKey ? `E2EE ${keyFingerprint(d.publicKey)}` : "无 E2EE 公钥",
                    d.lastSeen ? timeAgo(d.lastSeen) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Txt>
              </View>
              {!d.current ? (
                <Button
                  small
                  title={t.mgmt.revoke}
                  variant="danger"
                  loading={revoking === d.id}
                  onPress={() => void onRevoke(d)}
                />
              ) : null}
            </View>
          ))
        )}
      </Card>

      <SectionTitle>{t.mgmt.auditTitle}</SectionTitle>
      <Button
        title={auditOpen ? t.mgmt.auditHide : t.mgmt.auditShow}
        variant="secondary"
        loading={auditLoading}
        onPress={toggleAudit}
      />
      {auditOpen ? (
        <Card style={{ marginTop: 10, paddingVertical: 6 }}>
          {auditError ? <ErrorBanner message={auditError} onRetry={() => void loadAudit()} /> : null}
          {audit.length === 0 && !auditLoading ? (
            <Txt muted size={13} style={{ paddingVertical: 6 }}>
              {t.mgmt.auditEmpty}
            </Txt>
          ) : (
            audit.map((a, idx) => (
              <View
                key={`${a.ts}-${idx}`}
                style={[
                  styles.auditRow,
                  { borderBottomColor: c.border },
                  idx === audit.length - 1 && { borderBottomWidth: 0 },
                ]}
              >
                <Row>
                  <Txt weight="600" size={13} style={{ flex: 1 }}>
                    {a.action}
                  </Txt>
                  <Txt muted size={11}>
                    {timeAgo(a.ts)}
                  </Txt>
                </Row>
                <Txt muted size={12} style={MONO} numberOfLines={2}>
                  {a.actor}
                  {a.detail ? ` · ${a.detail}` : ""}
                </Txt>
              </View>
            ))
          )}
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  auditRow: {
    paddingVertical: 8,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
