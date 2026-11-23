import type { Capability, NodeInfo, Project, TaskConstraints } from "@agentfleet/proto";

import { t } from "../i18n/strings";

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t.time.justNow;
  const m = Math.floor(s / 60);
  if (m < 60) return t.time.minutesAgo(m);
  const h = Math.floor(m / 60);
  if (h < 24) return t.time.hoursAgo(h);
  return t.time.daysAgo(Math.floor(h / 24));
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function agentLabel(agent: TaskConstraints["agent"] | undefined): string {
  if (!agent || agent === "any") return t.tasks.agentAny;
  return Array.isArray(agent) ? agent.join(" / ") : agent;
}

/** A runtime is usable when its node is online, it's installed and not known-logged-out. */
export function runtimeUsable(node: NodeInfo, rt: Capability): boolean {
  return node.online && rt.installed && rt.loggedIn !== false;
}

export interface RuntimeChoice {
  id: string;
  agent: string;
  tier: Capability["tier"];
  /** Number of eligible nodes where this runtime is usable. */
  usableOn: number;
  /** true if logged in on at least one node, false if known logged-out everywhere, null if unknown. */
  loggedIn: boolean | null;
  installed: boolean;
  anyOnline: boolean;
  supports: Capability["supports"];
  note?: string;
}

/**
 * Collect the distinct runtimes across nodes (optionally limited to the nodes
 * that host `project`) for the agent picker on the New Task screen.
 */
export function collectRuntimes(nodes: readonly NodeInfo[], project?: Project | null): RuntimeChoice[] {
  const eligible = project ? nodes.filter((n) => project.nodes.includes(n.id) || n.projects.includes(project.id)) : nodes;
  const byId = new Map<string, RuntimeChoice>();
  for (const node of eligible) {
    for (const rt of node.runtimes) {
      let c = byId.get(rt.id);
      if (!c) {
        c = {
          id: rt.id,
          agent: rt.agent,
          tier: rt.tier,
          usableOn: 0,
          loggedIn: rt.loggedIn,
          installed: false,
          anyOnline: false,
          supports: rt.supports,
          note: rt.note,
        };
        byId.set(rt.id, c);
      }
      if (runtimeUsable(node, rt)) c.usableOn++;
      if (rt.installed) c.installed = true;
      if (node.online) c.anyOnline = true;
      if (rt.loggedIn === true) c.loggedIn = true;
      else if (rt.loggedIn === null && c.loggedIn === false) c.loggedIn = null;
      if (!c.note && rt.note) c.note = rt.note;
    }
  }
  return [...byId.values()].sort((a, b) => b.usableOn - a.usableOn || a.id.localeCompare(b.id));
}
