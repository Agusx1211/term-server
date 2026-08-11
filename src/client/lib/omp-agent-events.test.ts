import { describe, expect, it } from "vitest";
import { createSubagentActivityTracker } from "../../../integrations/omp/extensions/subagent-activity";

type SubagentStatus = "started" | "completed" | "failed" | "aborted";

function subagent(id: string, status: SubagentStatus) {
  return { id, status };
}

describe("OMP subagent activity", () => {
  it("defers parent settlement until an active child settles", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("child", "started"));
    tracker.onSubagentLifecycle(subagent("child", "started"));
    tracker.onParentEnd();

    expect(events).toEqual(["agent_start", "agent_start"]);

    tracker.onSubagentLifecycle(subagent("child", "completed"));

    expect(events).toEqual(["agent_start", "agent_start", "agent_settled"]);
  });

  it("waits for every overlapping child and ignores duplicate terminal events", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("first", "started"));
    tracker.onSubagentLifecycle(subagent("second", "started"));
    tracker.onParentEnd();
    tracker.onSubagentLifecycle(subagent("first", "failed"));
    tracker.onSubagentLifecycle(subagent("first", "aborted"));

    expect(events).toEqual(["agent_start", "agent_start", "agent_start"]);

    tracker.onSubagentLifecycle(subagent("second", "aborted"));
    tracker.onSubagentLifecycle(subagent("second", "completed"));

    expect(events).toEqual(["agent_start", "agent_start", "agent_start", "agent_settled"]);
  });

  it("ignores an unknown terminal event but accepts a later start", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("child", "completed"));
    tracker.onSubagentLifecycle(subagent("child", "started"));
    tracker.onParentEnd();

    expect(tracker.hasActiveWork()).toBe(true);
    expect(events).toEqual(["agent_start", "agent_start"]);

    tracker.onSubagentLifecycle(subagent("child", "completed"));

    expect(tracker.hasActiveWork()).toBe(false);
    expect(events).toEqual(["agent_start", "agent_start", "agent_settled"]);
  });

  it("allows an ID to be reused after its generation settles", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("reused", "started"));
    tracker.onParentEnd();
    tracker.onSubagentLifecycle(subagent("reused", "completed"));
    tracker.onSubagentLifecycle(subagent("reused", "started"));
    tracker.onSubagentLifecycle(subagent("reused", "completed"));

    expect(events).toEqual([
      "agent_start",
      "agent_start",
      "agent_settled",
      "agent_start",
      "agent_settled",
    ]);
  });

  it("keeps parent work active through a nonterminal end", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onParentEnd({ isTerminal: false });

    expect(tracker.hasActiveWork()).toBe(true);
    expect(events).toEqual(["agent_start"]);

    tracker.onParentEnd({ isTerminal: true });

    expect(tracker.hasActiveWork()).toBe(false);
    expect(events).toEqual(["agent_start", "agent_settled"]);
  });

  it("preserves detached children across parent turns", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("detached", "started"));
    tracker.onParentEnd();
    tracker.onParentStart();
    tracker.onParentEnd();

    expect(tracker.hasActiveWork()).toBe(true);
    expect(events).toEqual(["agent_start", "agent_start", "agent_start"]);

    tracker.onSubagentLifecycle(subagent("detached", "completed"));

    expect(tracker.hasActiveWork()).toBe(false);
    expect(events).toEqual(["agent_start", "agent_start", "agent_start", "agent_settled"]);
  });

  it("settles a parent with no children", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onParentEnd();
    tracker.onParentEnd();

    expect(events).toEqual(["agent_start", "agent_settled"]);
  });

  it("clears activity and ignores lifecycle events after shutdown", () => {
    const events: string[] = [];
    const tracker = createSubagentActivityTracker((event) => events.push(event));

    tracker.onParentStart();
    tracker.onSubagentLifecycle(subagent("child", "started"));
    tracker.shutdown();

    expect(tracker.hasActiveWork()).toBe(false);

    tracker.onParentEnd();
    tracker.onSubagentLifecycle(subagent("child", "completed"));

    expect(events).toEqual(["agent_start", "agent_start"]);
  });
});
