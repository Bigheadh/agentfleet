import { describe, expect, it } from "vitest";
import { EventEnvelope, type FleetEvent } from "@agentfleet/proto";
import { applyEvents, buildTimeline, emptyTimeline, pendingApprovals, type ToolItem } from "./reduce";

let seq = 0;
const env = (event: FleetEvent, s = seq++): EventEnvelope =>
  // Parse through the real schema so tests also catch protocol drift.
  EventEnvelope.parse({ runId: "r1", seq: s, ts: 1_700_000_000_000 + s, event });

const reset = () => {
  seq = 0;
};

describe("timeline reducer", () => {
  it("returns the same state for an empty batch", () => {
    expect(applyEvents(emptyTimeline, [])).toBe(emptyTimeline);
  });

  it("coalesces consecutive message deltas of the same role", () => {
    reset();
    const t = buildTimeline([
      env({ type: "message.delta", role: "agent", text: "Hel" }),
      env({ type: "message.delta", role: "agent", text: "lo" }),
      env({ type: "message.delta", role: "user", text: "hi" }),
      env({ type: "message.delta", role: "agent", text: "again" }),
    ]);
    expect(t.items.map((i) => (i.kind === "message" ? `${i.role}:${i.text}` : i.kind))).toEqual([
      "agent:Hello",
      "user:hi",
      "agent:again",
    ]);
    expect(t.lastSeq).toBe(3);
  });

  it("does not break coalescing on non-item events but does on reasoning", () => {
    reset();
    const t = buildTimeline([
      env({ type: "message.delta", role: "agent", text: "a" }),
      env({ type: "usage.updated", inputTokens: 10 }),
      env({ type: "message.delta", role: "agent", text: "b" }),
      env({ type: "reasoning.delta", text: "think " }),
      env({ type: "reasoning.delta", text: "more" }),
      env({ type: "message.delta", role: "agent", text: "c" }),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(["message", "reasoning", "message"]);
    expect(t.items[0]).toMatchObject({ text: "ab" });
    expect(t.items[1]).toMatchObject({ text: "think more" });
    expect(t.usage).toEqual({ inputTokens: 10 });
  });

  it("dedupes by seq across batches and within a batch", () => {
    reset();
    const a = env({ type: "message.delta", role: "agent", text: "x" }, 0);
    const b = env({ type: "message.delta", role: "agent", text: "y" }, 1);
    const t1 = buildTimeline([a, b]);
    const t2 = applyEvents(t1, [a, b]);
    expect(t2).toBe(t1);
    const c = env({ type: "message.delta", role: "agent", text: "z" }, 2);
    const t3 = applyEvents(t1, [b, c, c]);
    expect(t3.items).toHaveLength(1);
    expect(t3.items[0]).toMatchObject({ text: "xyz" });
    expect(t3.lastSeq).toBe(2);
  });

  it("sorts out-of-order envelopes", () => {
    const t = buildTimeline([
      env({ type: "message.delta", role: "agent", text: "2" }, 2),
      env({ type: "message.delta", role: "agent", text: "1" }, 1),
    ]);
    expect(t.items[0]).toMatchObject({ text: "12" });
  });

  it("does not mutate the previous state's items", () => {
    reset();
    const t1 = buildTimeline([env({ type: "message.delta", role: "agent", text: "a" })]);
    const first = t1.items[0];
    const t2 = applyEvents(t1, [env({ type: "message.delta", role: "agent", text: "b" })]);
    expect(first).toMatchObject({ text: "a" });
    expect(t2.items[0]).toMatchObject({ text: "ab" });
    expect(t2.items[0]).not.toBe(first);
  });

  it("tracks tool lifecycle with output deltas, diffs and exit code", () => {
    reset();
    const t = buildTimeline([
      env({ type: "tool.started", toolId: "t1", title: "Run tests", kind: "execute", input: { cmd: "pnpm test" } }),
      env({ type: "tool.updated", toolId: "t1", status: "in_progress", outputDelta: "PASS a\n" }),
      env({ type: "message.delta", role: "agent", text: "running" }),
      env({ type: "tool.updated", toolId: "t1", outputDelta: "PASS b\n" }),
      env({
        type: "tool.updated",
        toolId: "t1",
        status: "completed",
        exitCode: 0,
        diffs: [{ path: "a.ts", oldText: "1", newText: "2" }],
      }),
    ]);
    const tool = t.items[0] as ToolItem;
    expect(t.items.map((i) => i.kind)).toEqual(["tool", "message"]);
    expect(tool).toMatchObject({
      toolId: "t1",
      title: "Run tests",
      toolKind: "execute",
      status: "completed",
      output: "PASS a\nPASS b\n",
      exitCode: 0,
    });
    expect(tool.diffs).toHaveLength(1);
  });

  it("replaces accumulated output when a full `output` is sent", () => {
    reset();
    const t = buildTimeline([
      env({ type: "tool.started", toolId: "t1", title: "read", kind: "read" }),
      env({ type: "tool.updated", toolId: "t1", outputDelta: "partial" }),
      env({ type: "tool.updated", toolId: "t1", output: "full content" }),
      env({ type: "tool.updated", toolId: "t1", output: "full content v2", outputDelta: "!" }),
    ]);
    expect(t.items[0]).toMatchObject({ output: "full content v2!" });
  });

  it("creates a placeholder tool for updates without a start event", () => {
    reset();
    const t = buildTimeline([env({ type: "tool.updated", toolId: "orphan", status: "failed", outputDelta: "boom" })]);
    expect(t.items[0]).toMatchObject({ kind: "tool", title: "orphan", toolKind: "other", status: "failed", output: "boom" });
  });

  it("tracks approvals and their resolution", () => {
    reset();
    const options = [
      { id: "allow", label: "Allow", kind: "allow_once" as const },
      { id: "deny", label: "Deny", kind: "reject_once" as const },
    ];
    let t = buildTimeline([
      env({ type: "approval.requested", approvalId: "a1", title: "rm -rf build", risk: "danger", command: "rm -rf build", cwd: "/repo", options }),
      env({ type: "approval.requested", approvalId: "a2", title: "edit", risk: "write", options }),
      env({ type: "approval.requested", approvalId: "a1", title: "dup", risk: "danger", options }),
    ]);
    expect(t.items).toHaveLength(2);
    expect(pendingApprovals(t).map((a) => a.approvalId)).toEqual(["a1", "a2"]);
    t = applyEvents(t, [env({ type: "approval.resolved", approvalId: "a1", optionId: "deny", by: "user" })]);
    expect(pendingApprovals(t).map((a) => a.approvalId)).toEqual(["a2"]);
    expect(t.items[0]).toMatchObject({ resolution: { optionId: "deny", by: "user" } });
    // Unknown approval ids are ignored.
    const t2 = applyEvents(t, [env({ type: "approval.resolved", approvalId: "nope", optionId: null, by: "cancelled" })]);
    expect(t2.items).toEqual(t.items);
  });

  it("keeps latest plan, merged usage, latest diff and run status", () => {
    reset();
    const t = buildTimeline([
      env({ type: "plan.updated", entries: [{ content: "a", status: "pending" }] }),
      env({ type: "run.status", status: "running" }),
      env({ type: "usage.updated", inputTokens: 5, outputTokens: 1 }),
      env({ type: "plan.updated", entries: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }),
      env({ type: "usage.updated", outputTokens: 7, costUsd: 0.01 }),
      env({ type: "diff.updated", unified: "+x", files: 1, additions: 1, deletions: 0 }),
      env({ type: "log", level: "warn", text: "careful" }),
      env({ type: "run.status", status: "completed", detail: "ok" }),
    ]);
    expect(t.plan).toHaveLength(2);
    expect(t.plan?.[0]?.status).toBe("completed");
    expect(t.usage).toEqual({ inputTokens: 5, outputTokens: 7, costUsd: 0.01 });
    expect(t.diff).toEqual({ unified: "+x", files: 1, additions: 1, deletions: 0 });
    expect(t.status).toBe("completed");
    expect(t.items.map((i) => i.kind)).toEqual(["status", "log", "status"]);
  });
});
