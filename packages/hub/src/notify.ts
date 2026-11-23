/**
 * Push notifications for things that need the user's attention while the app is
 * in the background: approval requests and task outcomes.
 *
 * Channels (all optional, all best-effort — a failing channel never affects the hub):
 *  - Expo push: devices opt in from the app by registering an Expo push token.
 *    Content transits Expo + APNs/FCM; use `redact` to keep prompts/commands out.
 *  - ntfy (https://ntfy.sh or self-hosted): fully self-hostable alternative.
 *  - Webhook: generic JSON POST (bridge to Bark, Gotify, Slack, …).
 */
import type { NotificationKind, PushData } from "@agentfleet/proto";

export interface Notification {
  kind: NotificationKind;
  title: string;
  body: string;
  data: PushData;
  priority: "high" | "normal";
}

export interface NotifierConfig {
  /** Forward to Expo's push service for devices that registered a token. Default true. */
  expo?: boolean;
  expoUrl?: string;
  /** Full topic URL, e.g. https://ntfy.sh/my-secret-topic */
  ntfyUrl?: string;
  ntfyToken?: string;
  webhookUrl?: string;
  /** Leave task titles / commands out of notification bodies. */
  redact?: boolean;
}

export interface PushTarget {
  deviceId: string;
  token: string;
}

export interface NotifierDeps {
  /** Devices with a registered Expo push token. */
  targets: () => PushTarget[];
  /** Called when Expo reports a token as no longer valid. */
  invalidate: (token: string) => void;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH = 100;
const TIMEOUT_MS = 10_000;
export const ANDROID_CHANNEL_ID = "agentfleet";

export class Notifier {
  readonly redact: boolean;
  private pending = new Set<Promise<void>>();
  private fetch: typeof fetch;
  private log: (msg: string) => void;

  constructor(
    private cfg: NotifierConfig,
    private deps: NotifierDeps,
  ) {
    this.redact = cfg.redact ?? false;
    this.fetch = deps.fetch ?? fetch;
    this.log = deps.log ?? ((m) => console.warn(`[hub] notify: ${m}`));
  }

  get expoEnabled(): boolean {
    return this.cfg.expo !== false;
  }

  /** Non-Expo channels configured on this hub. */
  channels(): string[] {
    return [...(this.cfg.ntfyUrl ? ["ntfy"] : []), ...(this.cfg.webhookUrl ? ["webhook"] : [])];
  }

  /** Fire-and-forget; errors are logged. */
  notify(n: Notification) {
    const jobs: Promise<void>[] = [];
    if (this.expoEnabled) {
      const targets = this.deps.targets();
      if (targets.length) jobs.push(this.sendExpo(n, targets));
    }
    if (this.cfg.ntfyUrl) jobs.push(this.sendNtfy(n, this.cfg.ntfyUrl));
    if (this.cfg.webhookUrl) jobs.push(this.sendWebhook(n, this.cfg.webhookUrl));
    for (const job of jobs) {
      const p = job.catch((e: unknown) => this.log((e as Error).message)).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** Wait for in-flight deliveries (tests / graceful shutdown). */
  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async post(url: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  private async sendExpo(n: Notification, targets: PushTarget[]) {
    const tokens = [...new Set(targets.map((t) => t.token))];
    for (let i = 0; i < tokens.length; i += EXPO_BATCH) {
      const batch = tokens.slice(i, i + EXPO_BATCH);
      const messages = batch.map((to) => ({
        to,
        title: n.title,
        body: n.body,
        data: n.data,
        sound: n.priority === "high" ? "default" : undefined,
        priority: n.priority === "high" ? "high" : "default",
        channelId: ANDROID_CHANNEL_ID,
      }));
      const res = await this.post(this.cfg.expoUrl ?? EXPO_PUSH_URL, messages);
      const json = (await res.json().catch(() => ({}))) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
      json.data?.forEach((ticket, idx) => {
        if (ticket.status === "ok") return;
        const token = batch[idx]!;
        if (ticket.details?.error === "DeviceNotRegistered") {
          this.deps.invalidate(token);
          this.log(`removed unregistered Expo token ${token.slice(0, 24)}…`);
        } else {
          this.log(`expo: ${ticket.details?.error ?? ""} ${ticket.message ?? ""}`.trim());
        }
      });
    }
  }

  private async sendNtfy(n: Notification, topicUrl: string) {
    // JSON publishing (POST to the server root) so UTF-8 titles don't have to go into HTTP headers.
    const u = new URL(topicUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const topic = parts.pop();
    if (!topic) throw new Error("ntfy URL must include a topic, e.g. https://ntfy.sh/my-topic");
    const server = `${u.origin}/${parts.join("/")}`.replace(/\/$/, "");
    const tags = { approval: ["warning"], review: ["white_check_mark"], failed: ["x"] }[n.kind];
    await this.post(
      server || u.origin,
      {
        topic,
        title: n.title,
        message: n.body,
        priority: n.priority === "high" ? 4 : 3,
        tags,
        click: `agentfleet://tasks/${n.data.taskId}`,
      },
      this.cfg.ntfyToken ? { authorization: `Bearer ${this.cfg.ntfyToken}` } : {},
    );
  }

  private async sendWebhook(n: Notification, url: string) {
    await this.post(url, { source: "agentfleet", ...n });
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Builds notification text. Pure — exported for tests. */
export function buildNotification(
  input:
    | { kind: "approval"; project: string; taskTitle: string; taskId: string; runId: string; approvalTitle: string; risk: string }
    | { kind: "review" | "failed"; project: string; taskTitle: string; taskId: string; runId?: string; note?: string | null },
  redact: boolean,
): Notification {
  const data: PushData = { kind: input.kind, taskId: input.taskId, ...(input.runId ? { runId: input.runId } : {}) };
  if (input.kind === "approval") {
    return {
      kind: "approval",
      title: `需要审批 · ${input.project}`,
      body: redact ? "有一个操作等待你审批" : clip(`${input.taskTitle}\n[${input.risk}] ${input.approvalTitle}`, 240),
      data,
      priority: "high",
    };
  }
  if (input.kind === "review") {
    return { kind: "review", title: `任务待审阅 · ${input.project}`, body: redact ? "任务已完成，等待审阅" : clip(input.taskTitle, 240), data, priority: "normal" };
  }
  return {
    kind: "failed",
    title: `任务失败 · ${input.project}`,
    body: redact ? "任务失败" : clip(input.note ? `${input.taskTitle}\n${input.note}` : input.taskTitle, 240),
    data,
    priority: "normal",
  };
}
