import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetEvent, NodeToHub } from "@agentfleet/proto";
import { afterEach, describe, expect, it } from "vitest";
import { NodeConfig } from "../src/config.ts";
import { buildAdapters } from "../src/registry.ts";
import { Runner } from "../src/runner.ts";
import { fixtureCommand, tempDir, tempRepo, waitFor } from "./helpers.ts";

const runners: Runner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.shutdown()));
});

function setup(policy: unknown = {}, statePath = join(tempDir(), "runs.json"), repo = tempRepo()) {
  const acp = fixtureCommand("mock-acp-agent");
  const cfg = NodeConfig.parse({
    hub: "http://127.0.0.1:1",
    nodeId: "n1",
    token: "t",
    name: "n1",
    workRoot: tempDir("agentfleet-wt-"),
    projects: { demo: { path: repo } },
    agents: { "acp:mock": { command: acp.command, args: acp.args }, "acp:gemini": { enabled: false }, "acp:claude": { enabled: false }, "acp:codex": { enabled: false }, codex: { enabled: false } },
    policy,
  });
  const sent: NodeToHub[] = [];
  const runner = new Runner({ cfg, adapters: buildAdapters(cfg), send: (m) => sent.push(m), statePath, log: () => {} });
  runners.push(runner);
  const evs = (runId: string): FleetEvent[] => sent.flatMap((m) => (m.type === "run.event" && m.runId === runId ? [m.event] : []));
  const ended = (runId: string) => sent.filter((m) => m.type === "run.ended" && m.runId === runId);
  return { cfg, runner, sent, evs, ended, statePath, repo };
}

const spec = (runId: string, prompt = "写文件") => ({ runId, taskId: "t", project: "demo", runtimeId: "acp:mock", prompt });

describe("Runner", () => {
  it("auto-approves via node-local policy without asking the phone", async () => {
    const { runner, evs, ended, sent } = setup({ defaults: { write: "allow" } });
    await runner.assign(spec("run-policy-0001"));
    await waitFor(() => ended("run-policy-0001").length === 1, 15_000, "run.ended");
    expect(ended("run-policy-0001")[0]).toMatchObject({ status: "completed", error: null });
    const resolved = evs("run-policy-0001").find((e) => e.type === "approval.resolved");
    expect(resolved).toMatchObject({ by: "policy", optionId: "allow" });
    const started = sent.find((m) => m.type === "run.started");
    expect(readFileSync(join((started as { worktree: string }).worktree, "hello.txt"), "utf8")).toContain("turn 1");
  });

  it("denies via policy", async () => {
    const { runner, evs, ended } = setup({ defaults: { write: "deny" } });
    await runner.assign(spec("run-deny-00001"));
    await waitFor(() => ended("run-deny-00001").length === 1, 15_000, "run.ended");
    expect(evs("run-deny-00001").find((e) => e.type === "approval.resolved")).toMatchObject({ by: "policy", optionId: "reject" });
    const diff = evs("run-deny-00001").findLast((e) => e.type === "diff.updated");
    expect(diff).toMatchObject({ files: 0 });
  });

  it("fails fast for unknown projects and agents", async () => {
    const { runner, ended } = setup();
    await runner.assign({ ...spec("r-noproj"), project: "nope" });
    await runner.assign({ ...spec("r-noagent"), runtimeId: "acp:nope" });
    expect(ended("r-noproj")[0]).toMatchObject({ status: "failed" });
    expect(ended("r-noagent")[0]).toMatchObject({ status: "failed" });
  });

  it("revives a run after a daemon restart for follow-ups, without seq collisions", async () => {
    const first = setup({ defaults: { write: "allow" } });
    await first.runner.assign(spec("run-revive-001"));
    await waitFor(() => first.ended("run-revive-001").length === 1, 15_000, "first turn");
    const lastSeq = Math.max(...first.sent.flatMap((m) => (m.type === "run.event" ? [m.seq] : [])));
    await first.runner.shutdown();

    // New process: same state file + repo, fresh runner.
    const second = setup({ defaults: { write: "allow" } }, first.statePath, first.repo);
    second.cfg.workRoot = first.cfg.workRoot;
    expect(second.runner.activeRunIds()).toEqual([]);
    second.runner.input("run-revive-001", "再来");
    await waitFor(() => second.ended("run-revive-001").length === 1, 15_000, "revived turn");
    expect(second.sent[0]).toMatchObject({ type: "run.started", runId: "run-revive-001" });
    const seqs = second.sent.flatMap((m) => (m.type === "run.event" ? [m.seq] : []));
    expect(Math.min(...seqs)).toBeGreaterThan(lastSeq);
    expect(second.ended("run-revive-001")[0]).toMatchObject({ status: "completed" });
  });
});
