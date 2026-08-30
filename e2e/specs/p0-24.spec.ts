import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { expectTerminalBuffer } from "../assertions/terminal-state.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;

interface TerminalResponse {
  id: string;
  name: string;
  kind: "regular" | "supervisor";
}

async function createShellTerminal(page: Page): Promise<TerminalResponse> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "supervisor-history-target",
        cwd: "/tmp",
        shell: "/bin/sh",
      }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    return await response.json() as TerminalResponse;
  });
}

test("P0-24 Supervisor delivery and retained history are acknowledged @p0", async ({ page, baseURL }) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const target = await createShellTerminal(page);
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();

  const supervisorResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/supervisor"
  ));
  await page.getByRole("button", { name: "Create supervisor terminal", exact: true }).click();
  const supervisor = await (await supervisorResponse).json() as TerminalResponse;
  const supervisorPane = new TerminalPanePage(page, supervisor.id);
  await supervisorPane.expectConnected();

  const wakeMarker = "SUPERVISOR-DELIVERY-WAKE";
  const wakeCommand = `printf '${wakeMarker}\\n'`;
  await supervisorPane.sendInput(
    `term-server-supervisor send ${target.id} --text ${JSON.stringify(wakeCommand)} --enter`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: '"sent": true' }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const targetPane = await workbench.openTerminal({ id: target.id, name: target.name });
  await targetPane.expectConnected();
  await expectTerminalBuffer(page, target.id, { contains: wakeMarker }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const report = {
    hook_event_name: "transcript_snapshot",
    transcriptReset: true,
    transcript: [
      {
        kind: "message",
        sourceId: "message-1",
        timestamp: 1,
        role: "user",
        text: "SUPERVISOR-HISTORY-FIRST",
      },
      {
        kind: "message",
        sourceId: "message-2",
        timestamp: 2,
        role: "assistant",
        text: "SUPERVISOR-HISTORY-SECOND",
      },
    ],
  };
  const encodedReport = Buffer.from(JSON.stringify(report), "utf8").toString("base64");
  await targetPane.sendInput(
    `printf '%s' ${JSON.stringify(encodedReport)} | base64 -d | "$TERM_SERVER_EXECUTABLE" --agent-event omp; printf 'HISTORY-REPORT-DONE\\n'`,
    true,
  );
  await expectTerminalBuffer(page, target.id, { contains: "HISTORY-REPORT-DONE" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  await page.getByRole("button", { name: "Open supervisor terminal", exact: true }).click();
  await supervisorPane.expectConnected();
  await supervisorPane.sendInput(
    `term-server-supervisor transcript ${target.id} --limit 1 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: "SUPERVISOR-HISTORY-FIRST" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, supervisor.id, { contains: '"nextSequence":1' }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await supervisorPane.sendInput(
    `term-server-supervisor transcript ${target.id} --from-sequence 1 --limit 1 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: "SUPERVISOR-HISTORY-SECOND" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await supervisorPane.sendInput(
    `term-server-supervisor scrollback ${target.id} --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: wakeMarker }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, supervisor.id, { contains: '"recordType":"scrollback"' }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  await workbench.openTerminal({ id: target.id, name: target.name });
  await targetPane.expectConnected();
  await targetPane.sendInput(`term-server-supervisor transcript ${target.id}`, true);
  await expectTerminalBuffer(page, target.id, { contains: "term-server-supervisor: not found" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  await page.getByRole("button", { name: "Open supervisor terminal", exact: true }).click();
  await supervisorPane.sendInput(
    `term-server-supervisor send ${target.id} --text exit --enter`,
    true,
  );
  const targetRow = page.locator(`.terminal-row[data-terminal-id="${target.id}"]`);
  await expect(targetRow.locator(".tree-status")).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  await supervisorPane.sendInput(
    `term-server-supervisor send ${target.id} --text 'echo SHOULD-NOT-BE-SENT' --enter`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: "terminal is not running" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await supervisorPane.sendInput(
    `term-server-supervisor transcript ${target.id} --from-sequence 0 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, supervisor.id, { contains: "SUPERVISOR-HISTORY-SECOND" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
