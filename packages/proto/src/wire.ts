/**
 * Hub <-> Node (fleetd) wire protocol. JSON text frames over a WebSocket that the
 * node dials out to the hub (`/ws/node`, `Authorization: Bearer <nodeToken>`),
 * so nodes never need a public IP.
 */
import { z } from "zod";
import { Capability } from "./capability.ts";
import { FleetEvent, RunStatus, SealedBox } from "./events.ts";
import { RunAction, RunSpec } from "./models.ts";

export const PROTOCOL_VERSION = 1;

export const NodeHello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  node: z.object({
    id: z.string(),
    name: z.string(),
    os: z.string(),
    labels: z.array(z.string()),
    maxConcurrency: z.number().int().positive(),
    runtimes: z.array(Capability),
    projects: z.array(z.string()),
    publicKey: z.string().optional(),
  }),
  /** Runs still alive on the node after a reconnect. */
  activeRuns: z.array(z.string()),
});

export const NodeToHub = z.discriminatedUnion("type", [
  NodeHello,
  z.object({ type: z.literal("heartbeat"), running: z.number().int().nonnegative() }),
  z.object({ type: z.literal("capabilities"), runtimes: z.array(Capability), projects: z.array(z.string()) }),
  z.object({ type: z.literal("run.started"), runId: z.string(), branch: z.string().nullable(), worktree: z.string().nullable() }),
  /** `seq` is assigned by the node (monotonic per run) so the hub can dedupe on reconnect. */
  z.object({ type: z.literal("run.event"), runId: z.string(), seq: z.number().int().nonnegative(), ts: z.number(), event: FleetEvent }),
  z.object({ type: z.literal("run.ended"), runId: z.string(), status: RunStatus, error: z.string().nullable() }),
  z.object({
    type: z.literal("run.action.result"),
    requestId: z.string(),
    runId: z.string(),
    ok: z.boolean(),
    output: z.string(),
    url: z.string().optional(),
  }),
]);
export type NodeToHub = z.infer<typeof NodeToHub>;

export const HubToNode = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), nodeId: z.string(), hubName: z.string() }),
  z.object({ type: z.literal("run.assign"), spec: RunSpec }),
  z.object({ type: z.literal("run.input"), runId: z.string(), text: z.string(), e2ee: SealedBox.optional() }),
  z.object({ type: z.literal("run.approval"), runId: z.string(), approvalId: z.string(), optionId: z.string(), e2ee: SealedBox.optional() }),
  z.object({ type: z.literal("run.interrupt"), runId: z.string() }),
  z.object({ type: z.literal("run.action"), runId: z.string(), action: RunAction, requestId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type HubToNode = z.infer<typeof HubToNode>;
