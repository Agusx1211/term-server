interface SubagentLifecycleEvent {
  id: string;
  status: "started" | "completed" | "failed" | "aborted";
}

export interface SubagentActivityTracker {
  onParentStart(): void;
  onParentEnd(event?: unknown): void;
  onSubagentLifecycle(event: unknown): void;
  hasActiveWork(): boolean;
  shutdown(): void;
}

function isSubagentLifecycleEvent(event: unknown): event is SubagentLifecycleEvent {
  if (
    typeof event !== "object"
    || event === null
    || !("id" in event)
    || !("status" in event)
  ) return false;
  const id = event.id;
  const status = event.status;
  return typeof id === "string"
    && (
      status === "started"
      || status === "completed"
      || status === "failed"
      || status === "aborted"
    );
}

function isNonterminalAgentEnd(event: unknown): event is { isTerminal: false } {
  if (
    typeof event !== "object"
    || event === null
    || !("isTerminal" in event)
  ) return false;
  return event.isTerminal === false;
}

export function createSubagentActivityTracker(
  send: (event: string) => void,
): SubagentActivityTracker {
  const activeSubagents = new Set<string>();
  let parentActive = false;
  let parentSettled = false;
  let settlementReported = true;
  let shutdown = false;

  function settleIfReady(): void {
    if (
      parentSettled
      && activeSubagents.size === 0
      && !settlementReported
    ) {
      settlementReported = true;
      send("agent_settled");
    }
  }

  return {
    onParentStart() {
      if (shutdown) return;
      parentActive = true;
      parentSettled = false;
      settlementReported = false;
      send("agent_start");
    },
    onParentEnd(event?: unknown) {
      if (
        shutdown
        || !parentActive
        || parentSettled
        || isNonterminalAgentEnd(event)
      ) return;
      parentActive = false;
      parentSettled = true;
      settleIfReady();
    },
    onSubagentLifecycle(event) {
      if (shutdown || !isSubagentLifecycleEvent(event)) return;

      const id = event.id.trim();
      if (!id) return;

      if (event.status === "started") {
        if (activeSubagents.has(id)) return;
        activeSubagents.add(id);
        settlementReported = false;
        send("agent_start");
        return;
      }

      if (!activeSubagents.delete(id)) return;
      settleIfReady();
    },
    hasActiveWork() {
      return parentActive || activeSubagents.size > 0;
    },
    shutdown() {
      shutdown = true;
      parentActive = false;
      parentSettled = true;
      settlementReported = true;
      activeSubagents.clear();
    },
  };
}
