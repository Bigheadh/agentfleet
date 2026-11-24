/** Pure task filtering and search helpers for the Tasks tab. */
import type { Task } from "@agentfleet/proto";

export type TaskFilter = "all" | "waiting_approval" | "active" | "review" | "ended";

const ACTIVE_STATES: ReadonlySet<Task["state"]> = new Set(["queued", "assigned", "running"]);
const ENDED_STATES: ReadonlySet<Task["state"]> = new Set(["done", "failed", "cancelled"]);

export function matchesTaskFilter(task: Task, filter: TaskFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "waiting_approval":
      return task.state === "waiting_approval";
    case "active":
      return ACTIVE_STATES.has(task.state);
    case "review":
      return task.state === "review";
    case "ended":
      return ENDED_STATES.has(task.state);
  }
}

export function countTasksByFilter(tasks: readonly Task[]): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { all: tasks.length, waiting_approval: 0, active: 0, review: 0, ended: 0 };
  for (const t of tasks) {
    if (t.state === "waiting_approval") counts.waiting_approval++;
    else if (ACTIVE_STATES.has(t.state)) counts.active++;
    else if (t.state === "review") counts.review++;
    else if (ENDED_STATES.has(t.state)) counts.ended++;
  }
  return counts;
}

export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  query: string,
  titleOf: (task: Task) => string = (t) => t.title,
): Task[] {
  const q = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (!matchesTaskFilter(task, filter)) return false;
    if (!q) return true;
    const agent = Array.isArray(task.constraints.agent) ? task.constraints.agent.join(" ") : task.constraints.agent;
    return (
      titleOf(task).toLowerCase().includes(q) ||
      task.project.toLowerCase().includes(q) ||
      agent.toLowerCase().includes(q) ||
      (task.groupId?.toLowerCase().includes(q) ?? false)
    );
  });
}
