/**
 * Client (mobile app / web / CLI) <-> Hub API.
 *
 * REST under `/api/*` with `Authorization: Bearer <deviceToken>`, plus a live
 * WebSocket at `/ws/client?token=<deviceToken>` (query param because React
 * Native's WebSocket cannot reliably set headers).
 */
import { z } from "zod";
import { EventEnvelope } from "./events.ts";
import { NodeInfo, Priority, Run, RunAction, Task, TaskConstraints } from "./models.ts";

/** Encoded in the pairing QR code shown by `hub pair`. */
export const PairingPayload = z.object({
  v: z.literal(1),
  hub: z.string().url(),
  code: z.string(),
  name: z.string(),
});
export type PairingPayload = z.infer<typeof PairingPayload>;

export const PairRequest = z.object({ code: z.string(), deviceName: z.string().min(1).max(64) });
export const PairResponse = z.object({ token: z.string(), deviceId: z.string(), hubName: z.string() });
export type PairResponse = z.infer<typeof PairResponse>;

export const CreateTaskRequest = z.object({
  project: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().optional(),
  priority: Priority.default("normal"),
  constraints: TaskConstraints.partial().default({}),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const TaskDetail = z.object({ task: Task, runs: z.array(Run) });
export type TaskDetail = z.infer<typeof TaskDetail>;

export const Project = z.object({ id: z.string(), nodes: z.array(z.string()) });
export type Project = z.infer<typeof Project>;

export const InputRequest = z.object({ text: z.string().min(1) });
export const ApprovalDecisionRequest = z.object({ optionId: z.string() });
export const RunActionRequest = z.object({ action: RunAction });
export const RunActionResponse = z.object({ ok: z.boolean(), output: z.string(), url: z.string().optional() });
export type RunActionResponse = z.infer<typeof RunActionResponse>;

export const JoinTokenResponse = z.object({ token: z.string(), command: z.string() });

export const ClientToHub = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), runId: z.string(), after: z.number().int().default(-1) }),
  z.object({ type: z.literal("unsubscribe"), runId: z.string() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientToHub = z.input<typeof ClientToHub>;

export const HubToClient = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), envelope: EventEnvelope }),
  z.object({ type: z.literal("task"), task: Task }),
  z.object({ type: z.literal("run"), run: Run }),
  z.object({ type: z.literal("node"), node: NodeInfo }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type HubToClient = z.infer<typeof HubToClient>;
