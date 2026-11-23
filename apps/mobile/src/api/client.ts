/**
 * Typed REST client for the AgentFleet hub. Every response is validated with
 * the zod schemas from @agentfleet/proto so protocol drift surfaces as a clear
 * error instead of undefined-property crashes deep in the UI.
 */
import {
  MeResponse,
  NodeInfo,
  PairResponse,
  Project,
  Run,
  RunActionResponse,
  Task,
  TaskDetail,
  EventEnvelope,
  type CreateTaskRequest,
  type RegisterPushRequest,
  type RunAction,
} from "@agentfleet/proto";
import { z } from "zod";

import { t } from "../i18n/strings";

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network / timeout / validation errors. */
    readonly status: number,
    readonly kind: "http" | "network" | "timeout" | "invalid" = "http",
  ) {
    super(message);
    this.name = "ApiError";
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export { liveSocketUrl, normalizeHubUrl } from "../lib/url";

const ErrorBody = z.object({ error: z.string() });
const Ok = z.unknown();

async function request<S extends z.ZodType>(
  base: string,
  method: "GET" | "POST",
  path: string,
  schema: S,
  opts: { token?: string; body?: unknown } = {},
): Promise<z.output<S>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) throw new ApiError(t.common.timeout, 0, "timeout");
    throw new ApiError(`${t.common.networkError}${e instanceof Error && e.message ? `（${e.message}）` : ""}`, 0, "network");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiError(t.common.invalidResponse, res.status, "invalid");
    }
  }
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(json);
    const msg = parsed.success ? parsed.data.error : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
    throw new ApiError(res.status === 401 ? `${t.common.unauthorized}（${msg}）` : msg, res.status, "http");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    if (__DEV__) console.warn(`[api] ${method} ${path} response failed validation`, parsed.error.issues);
    throw new ApiError(`${t.common.invalidResponse}（${method} ${path}）`, res.status, "invalid");
  }
  return parsed.data;
}

/** Unauthenticated pairing call: exchanges the one-time code for a device token. */
export function pairWithHub(hub: string, code: string, deviceName: string): Promise<PairResponse> {
  return request(hub, "POST", "/api/pair", PairResponse, { body: { code, deviceName } });
}

export class HubClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private get<S extends z.ZodType>(path: string, schema: S) {
    return request(this.baseUrl, "GET", path, schema, { token: this.token });
  }
  private post<S extends z.ZodType>(path: string, schema: S, body: unknown = {}) {
    return request(this.baseUrl, "POST", path, schema, { token: this.token, body });
  }

  listNodes(): Promise<NodeInfo[]> {
    return this.get("/api/nodes", z.array(NodeInfo));
  }
  listProjects(): Promise<Project[]> {
    return this.get("/api/projects", z.array(Project));
  }
  listTasks(): Promise<Task[]> {
    return this.get("/api/tasks", z.array(Task));
  }
  createTask(req: CreateTaskRequest): Promise<Task> {
    return this.post("/api/tasks", Task, req);
  }
  getTask(id: string): Promise<TaskDetail> {
    return this.get(`/api/tasks/${encodeURIComponent(id)}`, TaskDetail);
  }
  cancelTask(id: string): Promise<unknown> {
    return this.post(`/api/tasks/${encodeURIComponent(id)}/cancel`, Ok);
  }
  retryTask(id: string): Promise<unknown> {
    return this.post(`/api/tasks/${encodeURIComponent(id)}/retry`, Ok);
  }
  getRun(id: string): Promise<Run> {
    return this.get(`/api/runs/${encodeURIComponent(id)}`, Run);
  }
  getRunEvents(id: string, after = -1): Promise<EventEnvelope[]> {
    return this.get(`/api/runs/${encodeURIComponent(id)}/events?after=${after}`, z.array(EventEnvelope));
  }
  sendInput(runId: string, text: string): Promise<unknown> {
    return this.post(`/api/runs/${encodeURIComponent(runId)}/input`, Ok, { text });
  }
  decideApproval(runId: string, approvalId: string, optionId: string): Promise<unknown> {
    return this.post(
      `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      Ok,
      { optionId },
    );
  }
  interrupt(runId: string): Promise<unknown> {
    return this.post(`/api/runs/${encodeURIComponent(runId)}/interrupt`, Ok);
  }
  runAction(runId: string, action: RunAction): Promise<RunActionResponse> {
    return this.post(`/api/runs/${encodeURIComponent(runId)}/actions`, RunActionResponse, { action });
  }
  me(): Promise<MeResponse> {
    return this.get("/api/me", MeResponse);
  }
  /** Register this device's Expo push token, or clear it with null. */
  registerPush(expoPushToken: string | null): Promise<unknown> {
    const body: RegisterPushRequest = { expoPushToken };
    return this.post("/api/devices/me/push", Ok, body);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
