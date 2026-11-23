import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Redirect } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, Card, ErrorBanner, SectionTitle, Txt } from "@/components/ui";
import { errorMessage } from "@/api/client";
import { t } from "@/i18n/strings";
import { normalizeHubUrl, parsePairingQr } from "@/lib/url";
import { useSession } from "@/state/session";
import { useColors } from "@/theme";

const CAN_SCAN = Platform.OS === "ios" || Platform.OS === "android";

export default function PairScreen() {
  const c = useColors();
  const { session, pair } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [hubUrl, setHubUrl] = useState("");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState<string>(t.pair.defaultDeviceName);
  const [scannedName, setScannedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  if (session) return <Redirect href="/" />;

  const submit = async (hubInput: string, codeInput: string) => {
    const hub = normalizeHubUrl(hubInput);
    if (!hub) return setError(t.pair.invalidUrl);
    if (!codeInput.trim()) return setError(t.pair.missingCode);
    setError(null);
    setBusy(true);
    try {
      await pair(hub, codeInput, deviceName.trim() || t.pair.defaultDeviceName);
      // The <Redirect> above takes over once the session is set.
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (res: BarcodeScanningResult) => {
    if (handled.current) return;
    const parsed = parsePairingQr(res.data);
    if (!parsed) {
      setError(t.pair.invalidQr);
      return;
    }
    handled.current = true;
    setScanning(false);
    setHubUrl(parsed.hub);
    setCode(parsed.code);
    setScannedName(parsed.name);
    void submit(parsed.hub, parsed.code).finally(() => {
      handled.current = false;
    });
  };

  const startScan = async () => {
    setError(null);
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return setError(t.pair.cameraDenied);
    }
    handled.current = false;
    setScanning(true);
  };

  const inputStyle = [styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.card }];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Txt size={28} weight="800">
            {t.appName}
          </Txt>
          <Txt size={20} weight="600" style={{ marginTop: 4 }}>
            {t.pair.title}
          </Txt>
          <Txt muted style={{ marginTop: 8, lineHeight: 21 }}>
            {t.pair.intro}
          </Txt>

          {error ? (
            <View style={{ marginTop: 16 }}>
              <ErrorBanner message={error} />
            </View>
          ) : null}
          {scannedName && busy ? (
            <Txt muted style={{ marginTop: 12 }}>
              {t.pair.scannedFrom(scannedName)}
            </Txt>
          ) : null}

          <SectionTitle>{t.pair.scan}</SectionTitle>
          {CAN_SCAN ? (
            scanning ? (
              <View>
                <View style={[styles.camera, { borderColor: c.primary }]}>
                  <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={onScanned}
                  />
                </View>
                <Txt muted style={{ textAlign: "center", marginTop: 8 }}>
                  {t.pair.scanning}
                </Txt>
                <Button title={t.pair.stopScan} variant="secondary" onPress={() => setScanning(false)} style={{ marginTop: 8 }} />
              </View>
            ) : (
              <Button
                title={permission && !permission.granted && !permission.canAskAgain ? t.pair.grantCamera : t.pair.scan}
                onPress={() => void startScan()}
                disabled={busy}
              />
            )
          ) : (
            <Txt muted>{t.pair.cameraUnavailable}</Txt>
          )}

          <SectionTitle>{t.pair.manual}</SectionTitle>
          <Card>
            <Txt muted size={13}>
              {t.pair.hubUrl}
            </Txt>
            <TextInput
              style={inputStyle}
              value={hubUrl}
              onChangeText={setHubUrl}
              placeholder={t.pair.hubUrlPlaceholder}
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
            />
            <Txt muted size={13} style={{ marginTop: 12 }}>
              {t.pair.code}
            </Txt>
            <TextInput
              style={inputStyle}
              value={code}
              onChangeText={setCode}
              placeholder={t.pair.codePlaceholder}
              placeholderTextColor={c.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Txt muted size={13} style={{ marginTop: 12 }}>
              {t.pair.deviceName}
            </Txt>
            <TextInput
              style={inputStyle}
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={64}
              placeholderTextColor={c.textMuted}
            />
            <Button
              title={busy ? t.pair.pairing : t.pair.submit}
              loading={busy}
              onPress={() => void submit(hubUrl, code)}
              style={{ marginTop: 16 }}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 48, maxWidth: 640, width: "100%", alignSelf: "center" },
  camera: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 2,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginTop: 6,
  },
});
