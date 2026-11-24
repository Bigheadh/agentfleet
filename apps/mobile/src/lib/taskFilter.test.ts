import type { Task } from "@agentfleet/proto";
import { describe, expect, it } from "vitest";
import { countTasksByFilter, filterTasks } from "./taskFilter";

function task(id: string, state: Task["state"], extra: Partial<Task> = {}): Task {
  return {
    id,
    project: "web",
    title: `Task ${id}`,
    prompt: "p",
    priority: "normal",
    constraints: { agent: "codex", requires: [], labels: [] },
    state,
    createdAt: 1,
    updatedAt: 1,
    runId: null,
    attempts: 0,
    ...extra,
  };
}

describe("taskFilter", () => {
  const sample = [
    task("1", "waiting_approval", { title: "修复登录" }),
    task("2", "running", { project: "api", constraints: { agent: "acp:gemini", requires: [], labels: [] } }),
    task("3", "queued"),
    task("4", "review", { title: "加密占位", groupId: "cmp-1" }),
    task("5", "done"),
    task("6", "failed"),
  ];

  it("counts each filter bucket", () => {
    expect(countTasksByFilter(sample)).toEqual({ all: 6, waiting_approval: 1, active: 2, review: 1, ended: 2 });
  });

  it("filters by state bucket and searches decrypted titles / projects / agents", () => {
    expect(filterTasks(sample, "active", "").map((t) => t.id)).toEqual(["2", "3"]);
    expect(filterTasks(sample, "ended", "").map((t) => t.id)).toEqual(["5", "6"]);
    expect(filterTasks(sample, "all", "gemini").map((t) => t.id)).toEqual(["2"]);
    expect(filterTasks(sample, "all", "cmp-1").map((t) => t.id)).toEqual(["4"]);
    // Matches decrypted title provided via titleOf callback.
    expect(filterTasks(sample, "review", "重构支付", (t) => (t.id === "4" ? "重构支付模块" : t.title)).map((t) => t.id)).toEqual(["4"]);
  });
});
