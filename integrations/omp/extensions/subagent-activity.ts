interface SubagentLifecycleEvent {
  id: string;
  status: "started" | "completed" | "failed" | "aborted";
}

export interface SubagentActivityTracker {
  onParentStart(): void;
  onParentEnd(): void;
  onSubagentLifecycle(event: unknown): void;
  shutdown(): void;
}

function isSubagentLifecycleEvent(event: unknown): event is SubagentLifecycleEvent {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as { id?: unknown; status?: unknown };
  return typeof candidate.id === "string"
    && (
      candidate.status === "started"
      || candidate.status === "completed"
      || candidate.status === "failed"
      || candidate.status === "aborted"
    );
}

export function createSubagentActivityTracker(
  send: (event: string) => void,
): SubagentActivityTracker {
  const states = new Map<string, "active" | "settled">();
  let parentSettled = false;
  let shutdown = false;

  function hasActiveSubagent(): boolean {
    for (const state of states.values()) {
      if (state === "active") return true;
    }
    return false;
  }

  function settleIfReady(): void {
    if (parentSettled && !hasActiveSubagent()) send("agent_settled");
  }

  return {
    onParentStart() {
      if (shutdown) return;
      parentSettled = false;
      send("agent_start");
    },
    onParentEnd() {
      if (shutdown || parentSettled) return;
      parentSettled = true;
      settleIfReady();
    },
    onSubagentLifecycle(event) {
      if (shutdown || !isSubagentLifecycleEvent(event)) return;

      const id = event.id.trim();
      if (!id) return;

      if (event.status === "started") {
        if (states.has(id)) return;
        states.set(id, "active");
        send("agent_start");
        return;
      }

      if (states.get(id) !== "active") {
        // Remember a terminal event that arrived before its start or was
        // already observed so duplicate/out-of-order events stay inert.
        if (!states.has(id)) states.set(id, "settled");
        return;
      }

      states.set(id, "settled");
      settleIfReady();
    },
    shutdown() {
      shutdown = true;
      parentSettled = false;
      states.clear();
    },
  };
}
