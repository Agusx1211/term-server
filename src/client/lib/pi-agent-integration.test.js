import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import termServerAgentEvents from "../../../integrations/pi/extensions/term-server-agent-events";

class FakeExtensionApi {
  handlers = new Map();

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async emit(event, payload, context = {}) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, context);
    }
  }
}

describe("Pi term-server transcript integration", () => {
  let directory = "";
  let capture = "";
  const originalEnvironment = {
    executable: process.env.TERM_SERVER_EXECUTABLE,
    session: process.env.TERM_SERVER_SESSION,
    socket: process.env.TERM_SERVER_BROKER_SOCKET,
    capture: process.env.HOOK_CAPTURE,
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "term-server-pi-events-"));
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

  it("forwards retained and live semantic messages", async () => {
    const api = new FakeExtensionApi();
    termServerAgentEvents(api);
    const context = {
      sessionManager: {
        getBranch: () => [{
          type: "message",
          id: "entry-1",
          timestamp: "2026-08-30T12:00:00.000Z",
          message: { role: "user", content: "inspect delivery", timestamp: 1 },
        }],
      },
    };

    await api.emit("session_start", {}, context);
    await api.emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "delivered" }], timestamp: 2 },
    }, context);
    await expect.poll(() => {
      if (!existsSync(capture)) return 0;
      return readFileSync(capture, "utf8").trim().split("\n").length;
    }).toBe(2);

    const reports = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(reports[0].hook_event_name).toBe("transcript_snapshot");
    expect(reports[0].transcript[0]).toMatchObject({
      sourceId: "entry-1",
      role: "user",
      text: "inspect delivery",
    });
    expect(reports[1].hook_event_name).toBe("message_end");
    expect(reports[1].transcript[0]).toMatchObject({
      role: "assistant",
      text: "delivered",
    });
  });
});
