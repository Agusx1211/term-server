import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import termServerAgentEvents from "../../../integrations/omp/extensions/term-server-agent-events";

class FakeExtensionApi {
  handlers = new Map();
  lifecycleHandlers = new Set();
  events = {
    on: (_channel, handler) => {
      this.lifecycleHandlers.add(handler);
      return () => this.lifecycleHandlers.delete(handler);
    },
  };

  getSessionName() {
    return "Lifecycle regression";
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async emit(event, payload, context) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, context);
    }
  }
}

describe("OMP term-server event integration", () => {
  let directory = "";
  let capture = "";
  const originalEnvironment = {
    executable: process.env.TERM_SERVER_EXECUTABLE,
    session: process.env.TERM_SERVER_SESSION,
    socket: process.env.TERM_SERVER_BROKER_SOCKET,
    capture: process.env.HOOK_CAPTURE,
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "term-server-omp-events-"));
    capture = join(directory, "events.jsonl");
    const executable = join(directory, "forward-event");
    writeFileSync(executable, "#!/bin/sh\ncat >>\"$HOOK_CAPTURE\"\nprintf '\\n' >>\"$HOOK_CAPTURE\"\n");
    chmodSync(executable, 0o755);
    process.env.TERM_SERVER_EXECUTABLE = executable;
    process.env.TERM_SERVER_SESSION = "00000000-0000-0000-0000-000000000001";
    process.env.TERM_SERVER_BROKER_SOCKET = join(directory, "broker.sock");
    process.env.HOOK_CAPTURE = capture;
  });

  afterEach(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("TERM_SERVER_EXECUTABLE", originalEnvironment.executable);
    restore("TERM_SERVER_SESSION", originalEnvironment.session);
    restore("TERM_SERVER_BROKER_SOCKET", originalEnvironment.socket);
    restore("HOOK_CAPTURE", originalEnvironment.capture);
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not report lifecycle events from a headless child session", async () => {
    const api = new FakeExtensionApi();
    termServerAgentEvents(api);
    const child = { hasUI: false };

    await api.emit("session_start", {}, child);
    await api.emit("agent_start", {}, child);
    await api.emit("agent_end", { isTerminal: true }, child);
    await api.emit("session_shutdown", {}, child);

    expect(existsSync(capture)).toBe(false);
  });

  it("orders root reports and ignores a nonterminal agent end", async () => {
    const api = new FakeExtensionApi();
    termServerAgentEvents(api);
    const root = { hasUI: true };

    await api.emit("session_start", {}, root);
    await api.emit("agent_start", {}, root);
    await api.emit("agent_end", { isTerminal: false }, root);
    await api.emit("agent_end", { isTerminal: true }, root);
    await expect.poll(() => {
      if (!existsSync(capture)) return 0;
      return readFileSync(capture, "utf8").trim().split("\n").length;
    }).toBe(2);
    await api.emit("session_shutdown", {}, root);

    const reports = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(reports.map((report) => report.hook_event_name)).toEqual([
      "agent_start",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(reports[0].sequence).toBeLessThan(reports[1].sequence);
    expect(reports[1].sequence).toBeLessThan(reports[2].sequence);
  });
});
