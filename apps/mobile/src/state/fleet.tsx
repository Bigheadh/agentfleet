/**
 * Shared, live-updating lists (tasks, nodes, projects). Fetched over REST and
 * patched in place by WS `task` / `node` messages; refetched after reconnects.
 */
import type { NodeInfo, Project, Task } from "@agentfleet/proto";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { errorMessage, type HubClient } from "../api/client";
import type { LiveSocket } from "../api/ws";

interface Loadable<T> {
  data: T;
  loading: boolean;
  error: string | null;
  loaded: boolean;
}

interface FleetContextValue {
  tasks: Loadable<Task[]>;
  nodes: Loadable<NodeInfo[]>;
  projects: Loadable<Project[]>;
  refreshTasks: () => Promise<void>;
  refreshNodes: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  upsertTask: (task: Task) => void;
  nodeById: (id: string) => NodeInfo | undefined;
  /** Number of tasks currently waiting for an approval decision. */
  waitingApproval: number;
}

const FleetContext = createContext<FleetContextValue | null>(null);

const initial = <T,>(data: T): Loadable<T> => ({ data, loading: false, error: null, loaded: false });

function sortTasks(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function useLoadable<T>(fetcher: () => Promise<T>, empty: T) {
  const [state, setState] = useState<Loadable<T>>(() => initial(empty));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetcherRef.current();
      setState({ data, loading: false, error: null, loaded: true });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(e), loaded: true }));
    }
  }, []);
  return [state, setState, refresh] as const;
}

export function FleetProvider({ client, socket, children }: { client: HubClient; socket: LiveSocket; children: ReactNode }) {
  const [tasks, setTasks, refreshTasks] = useLoadable(async () => sortTasks(await client.listTasks()), [] as Task[]);
  const [nodes, setNodes, refreshNodes] = useLoadable(() => client.listNodes(), [] as NodeInfo[]);
  const [projects, , refreshProjects] = useLoadable(() => client.listProjects(), [] as Project[]);

  const upsertTask = useCallback(
    (task: Task) =>
      setTasks((s) => {
        const idx = s.data.findIndex((t) => t.id === task.id);
        if (idx >= 0 && s.data[idx]!.updatedAt > task.updatedAt) return s; // stale
        const data = idx >= 0 ? s.data.map((t, i) => (i === idx ? task : t)) : sortTasks([task, ...s.data]);
        return { ...s, data };
      }),
    [setTasks],
  );

  const upsertNode = useCallback(
    (node: NodeInfo) =>
      setNodes((s) => {
        const idx = s.data.findIndex((n) => n.id === node.id);
        const data = idx >= 0 ? s.data.map((n, i) => (i === idx ? node : n)) : [...s.data, node];
        return { ...s, data };
      }),
    [setNodes],
  );

  useEffect(() => {
    void refreshTasks();
    void refreshNodes();
    void refreshProjects();
  }, [refreshTasks, refreshNodes, refreshProjects]);

  useEffect(
    () =>
      socket.addListeners({
        task: upsertTask,
        node: upsertNode,
        open: (reconnect) => {
          if (reconnect) {
            void refreshTasks();
            void refreshNodes();
          }
        },
      }),
    [socket, upsertTask, upsertNode, refreshTasks, refreshNodes],
  );

  const nodeById = useCallback((id: string) => nodes.data.find((n) => n.id === id), [nodes.data]);
  const waitingApproval = useMemo(() => tasks.data.filter((t) => t.state === "waiting_approval").length, [tasks.data]);

  const value = useMemo<FleetContextValue>(
    () => ({ tasks, nodes, projects, refreshTasks, refreshNodes, refreshProjects, upsertTask, nodeById, waitingApproval }),
    [tasks, nodes, projects, refreshTasks, refreshNodes, refreshProjects, upsertTask, nodeById, waitingApproval],
  );
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): FleetContextValue {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used inside <FleetProvider>");
  return ctx;
}
