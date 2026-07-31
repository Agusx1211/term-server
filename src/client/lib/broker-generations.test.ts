import { describe, expect, it } from "vitest";
import type { SessionBrokerInfo, TerminalInfo } from "../../shared/types";
import { withBrokerSessions } from "./broker-generations";

const broker: SessionBrokerInfo = {
  version: "0.8.0",
  commit: "current",
  sessions: 2,
  restartRequired: true,
  generations: [
    { version: "0.8.0", commit: "current", sessions: 1, current: true },
    { version: "0.7.3", commit: "old", sessions: 1, current: false },
  ],
};

const terminal = (id: string, version: string, commit: string): TerminalInfo => ({
  id,
  name: id,
  workspace: "~",
  path: `~/${id}`,
  cwd: "/tmp",
  shell: "/bin/sh",
  program: "sh",
  color: "#000",
  agent: null,
  command: null,
  createdAt: 1,
  pid: 1,
  status: "running",
  exitCode: null,
  clients: 0,
  broker: { version, commit },
});

describe("broker generation session counts", () => {
  it("retires the warning when the last old terminal closes", () => {
    const updated = withBrokerSessions(broker, [
      terminal("current", "0.8.0", "current"),
    ]);

    expect(updated.sessions).toBe(1);
    expect(updated.restartRequired).toBe(false);
    expect(updated.generations).toEqual([
      { version: "0.8.0", commit: "current", sessions: 1, current: true },
      { version: "0.7.3", commit: "old", sessions: 0, current: false },
    ]);
  });

  it("discovers a terminal generation absent from the initial config", () => {
    const updated = withBrokerSessions(
      { ...broker, generations: broker.generations.slice(0, 1) },
      [terminal("old", "0.7.2", "older")],
    );

    expect(updated.restartRequired).toBe(true);
    expect(updated.generations[1]).toEqual({
      version: "0.7.2",
      commit: "older",
      sessions: 1,
      current: false,
    });
  });
});
