import type { Capability, NodeInfo, Task } from "@agentfleet/proto";
import { describe, expect, it } from "vitest";
import { explainNoMatch, queueOrder, rankCandidates } from "../src/scheduler.ts";

const cap = (id: string, over: Partial<Capability> = {}): Capability => ({
  id,
  agent: id,
  tier: id.startsWith("acp:") ? "acp" : "native",
  version: "1",
  installed: true,
  loggedIn: true,
  models: [],
  supports: ["interactiveApproval", "multiTurn"],
  ...over,
});

const node = (id: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  id,
  name: id,
  os: "linux",
  labels: [],
  maxConcurrency: 2,
  running: 0,
  online: true,
  lastSeen: 0,
  runtimes: [cap("codex"), cap("acp:gemini")],
  projects: ["web"],
  ...over,
});

const task = (over: Omit<Partial<Task>, "constraints"> & { constraints?: Partial<Task["constraints"]> } = {}): Task => ({
  id: "t",
  project: "web",
  title: "t",
  prompt: "p",
  priority: "normal",
  state: "queued",
  createdAt: 0,
  updatedAt: 0,
  runId: null,
  attempts: 0,
  note: null,
  ...over,
  constraints: { agent: "any", requires: [], labels: [], ...over.constraints },
});

describe("rankCandidates", () => {
  it("prefers native tier and less loaded nodes", () => {
    const r = rankCandidates(task(), [node("busy", { running: 1 }), node("idle")]);
    expect(r[0]!.node.id).toBe("idle");
    expect(r[0]!.runtime.id).toBe("codex");
  });

  it("filters by agent, project, labels, capability and login", () => {
    const nodes = [
      node("a", { runtimes: [cap("codex", { loggedIn: false }), cap("acp:gemini")] }),
      node("b", { labels: ["gpu"], projects: ["api"] }),
      node("c", { labels: ["gpu"] }),
    ];
    expect(rankCandidates(task({ constraints: { agent: "codex" } }), nodes).map((c) => c.node.id)).toEqual(["c"]);
    expect(rankCandidates(task({ constraints: { labels: ["gpu"] } }), nodes).every((c) => c.node.id === "c")).toBe(true);
    expect(rankCandidates(task({ constraints: { requires: ["fork"] } }), nodes)).toEqual([]);
  });

  it("honours preference order in agent lists", () => {
    const r = rankCandidates(task({ constraints: { agent: ["acp:gemini", "codex"] } }), [node("a")]);
    expect(r.map((c) => c.runtime.id)).toEqual(["acp:gemini", "codex"]);
  });

  it("skips offline and full nodes", () => {
    expect(rankCandidates(task(), [node("off", { online: false }), node("full", { running: 2 })])).toEqual([]);
  });
});

describe("explainNoMatch", () => {
  it("explains common reasons", () => {
    expect(explainNoMatch(task(), [])).toBe("没有已注册的节点");
    expect(explainNoMatch(task({ project: "x" }), [node("a")])).toContain("x");
    expect(explainNoMatch(task(), [node("a", { running: 2 })])).toContain("并发");
    expect(explainNoMatch(task({ constraints: { agent: "acp:claude" } }), [node("a")])).toContain("acp:claude");
  });
});

describe("queueOrder", () => {
  it("orders by priority then FIFO", () => {
    const ts = [task({ id: "1", createdAt: 1 }), task({ id: "2", priority: "high", createdAt: 2 }), task({ id: "3", createdAt: 0 })];
    expect(ts.sort(queueOrder).map((t) => t.id)).toEqual(["2", "3", "1"]);
  });
});
