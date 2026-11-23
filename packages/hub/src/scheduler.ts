/**
 * Capability-aware scheduler (design doc §6.2): filter (node, runtime) pairs,
 * then score. Pure functions — no I/O — so they're easy to test and tune.
 */
import { keyId, TIER_SCORE, type Capability, type NodeInfo, type Task } from "@agentfleet/proto";

export interface Candidate {
  node: NodeInfo;
  runtime: Capability;
  score: number;
}

export interface ScheduleContext {
  /** Runtime ids excluded for this task (e.g. failed previously). */
  excludeRuntimes?: Set<string>;
  /** Remaining quota ratio [0,1] per `${nodeId}/${runtimeId}`; unknown -> conservative default. */
  quota?: Map<string, number>;
}

export const WEIGHTS = { quota: 0.3, load: 0.3, tier: 0.25, preference: 0.15 } as const;
const UNKNOWN_QUOTA = 0.3;

export function runtimeMatches(agent: Task["constraints"]["agent"], runtimeId: string): boolean {
  if (agent === "any") return true;
  if (Array.isArray(agent)) return agent.includes(runtimeId);
  return agent === runtimeId;
}

export function isUsable(rt: Capability): boolean {
  return rt.installed && rt.loggedIn !== false;
}

function nodeCanDecrypt(task: Task, node: NodeInfo): boolean {
  if (!task.e2ee) return true;
  if (!node.publicKey) return false;
  try {
    const kid = keyId(node.publicKey);
    return task.e2ee.keys.some((k) => k.kid === kid);
  } catch {
    return false;
  }
}

export function rankCandidates(task: Task, nodes: NodeInfo[], ctx: ScheduleContext = {}): Candidate[] {
  const c = task.constraints;
  const out: Candidate[] = [];
  for (const node of nodes) {
    if (!node.online || node.running >= node.maxConcurrency) continue;
    if (c.nodeId && c.nodeId !== node.id) continue;
    if (!node.projects.includes(task.project)) continue;
    if (!nodeCanDecrypt(task, node)) continue;
    if (!c.labels.every((l) => node.labels.includes(l))) continue;
    for (const rt of node.runtimes) {
      if (!isUsable(rt) || !runtimeMatches(c.agent, rt.id)) continue;
      if (ctx.excludeRuntimes?.has(rt.id)) continue;
      if (!c.requires.every((f) => rt.supports.includes(f))) continue;
      const quota = ctx.quota?.get(`${node.id}/${rt.id}`) ?? UNKNOWN_QUOTA;
      const load = 1 - node.running / node.maxConcurrency;
      const preferred = Array.isArray(c.agent) ? 1 - c.agent.indexOf(rt.id) / c.agent.length : c.agent === rt.id ? 1 : 0.5;
      const score =
        WEIGHTS.quota * quota + WEIGHTS.load * load + WEIGHTS.tier * TIER_SCORE[rt.tier] + WEIGHTS.preference * preferred;
      out.push({ node, runtime: rt, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const;

/** Queue order: priority first, then FIFO. */
export function queueOrder(a: Task, b: Task): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt;
}

/** Explains why nothing matched — surfaced to the app so "queued forever" is debuggable. */
export function explainNoMatch(task: Task, nodes: NodeInfo[]): string {
  if (nodes.length === 0) return "没有已注册的节点";
  const online = nodes.filter((n) => n.online);
  if (online.length === 0) return "所有节点离线";
  const withProject = online.filter((n) => n.projects.includes(task.project));
  if (withProject.length === 0) return `没有节点配置了项目 "${task.project}"`;
  const decryptable = withProject.filter((n) => nodeCanDecrypt(task, n));
  if (decryptable.length === 0) return "没有持有此加密任务密钥的在线节点";
  const free = decryptable.filter((n) => n.running < n.maxConcurrency);
  if (free.length === 0) return "节点并发已满，排队中";
  const rts = free.flatMap((n) => n.runtimes).filter((r) => runtimeMatches(task.constraints.agent, r.id));
  if (rts.length === 0) return `没有匹配的 agent: ${JSON.stringify(task.constraints.agent)}`;
  if (!rts.some(isUsable)) return "匹配的 agent 未安装或未登录";
  return "没有满足能力要求的 agent";
}
