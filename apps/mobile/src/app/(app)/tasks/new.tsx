import Ionicons from "@expo/vector-icons/Ionicons";
import {
  ENCRYPTED_PLACEHOLDER,
  ENCRYPTED_TASK_TITLE,
  encryptTaskPayload,
  type Priority,
  type Project,
} from "@agentfleet/proto";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { errorMessage } from "@/api/client";
import { Button, Card, Chip, ErrorBanner, Loading, Row, SectionTitle, Txt } from "@/components/ui";
import { t } from "@/i18n/strings";
import { selectE2EERecipients } from "@/lib/e2eePure";
import { collectRuntimes, type RuntimeChoice } from "@/lib/format";
import { useE2EE } from "@/state/e2ee";
import { useFleet } from "@/state/fleet";
import { usePaired } from "@/state/session";
import { useColors } from "@/theme";

const PRIORITIES: Priority[] = ["low", "normal", "high"];

function runtimeSublabel(rt: RuntimeChoice): string {
  const login = rt.loggedIn === true ? t.newTask.loggedIn : rt.loggedIn === false ? t.newTask.notLoggedIn : t.newTask.loginUnknown;
  if (rt.usableOn > 0) return `${t.tier[rt.tier]} · ${login} · ${t.newTask.availableOn(rt.usableOn)}`;
  const why = !rt.installed ? t.newTask.notInstalled : !rt.anyOnline ? t.newTask.offline : login;
  return `${t.tier[rt.tier]} · ${why}`;
}

export default function NewTaskScreen() {
  const c = useColors();
  const { client } = usePaired();
  const { keyPair, enabled: e2eeEnabled, trustedNodes, devicePublicKeys } = useE2EE();
  const { projects, nodes, refreshProjects, refreshNodes, upsertTask } = useFleet();
  const [project, setProject] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>("any");
  const [priority, setPriority] = useState<Priority>("normal");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshProjects();
    void refreshNodes();
  }, [refreshProjects, refreshNodes]);

  // Preselect when there is exactly one project.
  useEffect(() => {
    if (!project && projects.data.length === 1) setProject(projects.data[0]!.id);
  }, [project, projects.data]);

  const selectedProject: Project | null = useMemo(
    () => projects.data.find((p) => p.id === project) ?? null,
    [projects.data, project],
  );
  const runtimes = useMemo(() => collectRuntimes(nodes.data, selectedProject), [nodes.data, selectedProject]);
  const recipients = useMemo(
    () => selectE2EERecipients(nodes.data, selectedProject, trustedNodes, devicePublicKeys),
    [nodes.data, selectedProject, trustedNodes, devicePublicKeys],
  );
  const willEncrypt = e2eeEnabled && !!keyPair && recipients.trustedNodes.length > 0;

  // Reset the agent if it became unavailable for the chosen project.
  useEffect(() => {
    if (agent !== "any" && !runtimes.some((r) => r.id === agent && r.usableOn > 0)) setAgent("any");
  }, [agent, runtimes]);

  const submit = async () => {
    if (!project) return setError(t.newTask.pickProject);
    if (!prompt.trim()) return setError(t.newTask.promptRequired);
    setError(null);
    setBusy(true);
    try {
      const cleanPrompt = prompt.trim();
      const cleanTitle = title.trim() || cleanPrompt.split("\n")[0]!.slice(0, 80);
      const req = willEncrypt
        ? {
            project,
            title: ENCRYPTED_TASK_TITLE,
            prompt: ENCRYPTED_PLACEHOLDER,
            priority,
            constraints: { agent },
            e2ee: encryptTaskPayload({ title: cleanTitle, prompt: cleanPrompt }, keyPair!, recipients.recipientKeys, project).e2ee,
          }
        : {
            project,
            prompt: cleanPrompt,
            title: title.trim() || undefined,
            priority,
            constraints: { agent },
          };
      const task = await client.createTask(req);
      upsertTask(task);
      router.replace(`/tasks/${task.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!projects.loaded && projects.loading) return <Loading />;

  const inputStyle = [styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.card }];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {error ? <ErrorBanner message={error} /> : null}
        {projects.error ? <ErrorBanner message={projects.error} onRetry={() => void refreshProjects()} /> : null}

        <Card style={{ marginBottom: 10 }}>
          <Row gap={8}>
            <Ionicons
              name={willEncrypt ? "shield-checkmark" : "lock-open-outline"}
              size={18}
              color={willEncrypt ? c.success : e2eeEnabled ? c.warning : c.textMuted}
            />
            <Txt size={13} style={{ flex: 1 }} color={willEncrypt ? c.success : c.textMuted}>
              {!e2eeEnabled
                ? t.e2ee.newTaskPlain
                : willEncrypt
                  ? t.e2ee.newTaskReady(recipients.trustedNodes.length)
                  : t.e2ee.newTaskNeedTrust}
            </Txt>
          </Row>
          {recipients.mismatchNodes.length > 0 ? (
            <Txt size={12} color={c.danger} style={{ marginTop: 6 }}>
              {t.e2ee.newTaskMismatchWarn(recipients.mismatchNodes.length)}
            </Txt>
          ) : null}
          {e2eeEnabled && !willEncrypt ? (
            <View style={{ marginTop: 8 }}>
              <Button title={t.e2ee.goVerifyNodes} variant="secondary" onPress={() => router.replace("/nodes")} />
            </View>
          ) : null}
        </Card>

        <SectionTitle>{t.newTask.project}</SectionTitle>
        {projects.data.length === 0 ? (
          <Txt muted>{t.newTask.noProjects}</Txt>
        ) : (
          <Row style={styles.wrap}>
            {projects.data.map((p) => (
              <Chip
                key={p.id}
                label={p.id}
                sublabel={t.newTask.projectNodes(p.nodes.length)}
                selected={project === p.id}
                onPress={() => setProject(p.id)}
              />
            ))}
          </Row>
        )}

        <SectionTitle>{t.newTask.agent}</SectionTitle>
        <Row style={styles.wrap}>
          <Chip label={t.newTask.agentAny} selected={agent === "any"} onPress={() => setAgent("any")} />
          {runtimes.map((rt) => (
            <Chip
              key={rt.id}
              label={`${rt.agent} (${rt.id})`}
              sublabel={runtimeSublabel(rt)}
              selected={agent === rt.id}
              disabled={rt.usableOn === 0}
              onPress={() => setAgent(rt.id)}
            />
          ))}
        </Row>

        <SectionTitle>{t.newTask.priority}</SectionTitle>
        <Row>
          {PRIORITIES.map((p) => (
            <Chip key={p} label={t.priority[p]} selected={priority === p} onPress={() => setPriority(p)} />
          ))}
        </Row>

        <SectionTitle>{t.newTask.taskTitle}</SectionTitle>
        <TextInput
          style={inputStyle}
          value={title}
          onChangeText={setTitle}
          placeholder={t.newTask.taskTitlePlaceholder}
          placeholderTextColor={c.textMuted}
        />

        <SectionTitle>{t.newTask.prompt}</SectionTitle>
        <TextInput
          style={[inputStyle, styles.prompt]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={t.newTask.promptPlaceholder}
          placeholderTextColor={c.textMuted}
          multiline
          textAlignVertical="top"
        />

        <View style={{ height: 20 }} />
        <Button
          title={busy ? t.newTask.submitting : t.newTask.submit}
          loading={busy}
          disabled={!project || !prompt.trim()}
          onPress={() => void submit()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 48 },
  wrap: { flexWrap: "wrap" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  prompt: { minHeight: 160 },
});
