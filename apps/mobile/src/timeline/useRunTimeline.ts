import type { EventEnvelope } from "@agentfleet/proto";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, type HubClient } from "../api/client";
import type { LiveSocket } from "../api/ws";
import { applyEvents, emptyTimeline, type TimelineState } from "./reduce";

/** Coalesce bursts of streamed deltas into one render. */
const FLUSH_MS = 50;

/**
 * Backfill a run's events over REST, then follow it live over the WS. The WS
 * subscription always asks for `after = lastSeq`, including after reconnects.
 */
export function useRunTimeline(client: HubClient, socket: LiveSocket, runId: string | null) {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<TimelineState>(emptyTimeline);
  const queue = useRef<EventEnvelope[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const batch = queue.current;
    queue.current = [];
    const next = applyEvents(stateRef.current, batch);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
  }, []);

  const enqueue = useCallback(
    (envs: EventEnvelope[]) => {
      queue.current.push(...envs);
      if (!timer.current) timer.current = setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  useEffect(() => {
    stateRef.current = emptyTimeline;
    queue.current = [];
    setState(emptyTimeline);
    setError(null);
    if (!runId) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setLoading(true);
    const follow = () => {
      if (cancelled) return;
      unsubscribe = socket.subscribeRun(runId, (e) => enqueue([e]), () => {
        // Include queued-but-unflushed events in the cursor.
        let seq = stateRef.current.lastSeq;
        for (const e of queue.current) if (e.seq > seq) seq = e.seq;
        return seq;
      });
    };
    client
      .getRunEvents(runId, -1)
      .then((envs) => {
        if (cancelled) return;
        stateRef.current = applyEvents(emptyTimeline, envs);
        setState(stateRef.current);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        follow();
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [client, socket, runId, enqueue]);

  /** Pull-to-refresh: fetch anything after our cursor (covers missed WS frames). */
  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const envs = await client.getRunEvents(runId, stateRef.current.lastSeq);
      enqueue(envs);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [client, runId, enqueue]);

  return { timeline: state, loading, error, refresh };
}
