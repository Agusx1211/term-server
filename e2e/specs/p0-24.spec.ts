import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { expectTerminalBuffer } from "../assertions/terminal-state.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;
const CONTROL = '"$TERM_SERVER_EXECUTABLE" access terminals --agent e2e';

interface TerminalResponse {
  id: string;
  name: string;
}

async function createShellTerminal(page: Page, path: string): Promise<TerminalResponse> {
  return page.evaluate(async (path) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: "/bin/sh" }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    return await response.json() as TerminalResponse;
  }, path);
}

async function updateControl(
  page: Page,
  terminalId: string,
  update: { exposure?: "off" | "read" | "write"; controller?: boolean },
): Promise<void> {
  await page.evaluate(async ({ terminalId, update }) => {
    const response = await fetch(`/api/terminals/${terminalId}/control`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!response.ok) throw new Error(`control update failed (${response.status})`);
  }, { terminalId, update });
}

test("P0-24 Controlled delivery and retained history are acknowledged @p0", async ({ page, baseURL }) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const target = await createShellTerminal(page, "controlled-history-target");
  const controller = await createShellTerminal(page, "history-controller");
  await updateControl(page, controller.id, { controller: true });
  await updateControl(page, target.id, { exposure: "write" });
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();

  const controllerPane = await workbench.openTerminal({ id: controller.id, name: controller.name });
  await controllerPane.expectConnected();

  const wakeMarker = "CONTROL-DELIVERY-WAKE";
  const wakeCommand = `printf '${wakeMarker}\\n'`;
  await controllerPane.sendInput(
    `${CONTROL} send ${target.id} --text ${JSON.stringify(wakeCommand)} --enter`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: '"sent": true' }, {
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
        text: "CONTROL-HISTORY-FIRST",
      },
      {
        kind: "message",
        sourceId: "message-2",
        timestamp: 2,
        role: "assistant",
        text: "CONTROL-HISTORY-SECOND",
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

  await workbench.openTerminal({ id: controller.id, name: controller.name });
  await controllerPane.expectConnected();
  await controllerPane.sendInput(
    `${CONTROL} transcript ${target.id} --limit 1 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: "CONTROL-HISTORY-FIRST" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, controller.id, { contains: '"nextSequence":1' }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await controllerPane.sendInput(
    `${CONTROL} transcript ${target.id} --from-sequence 1 --limit 1 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: "CONTROL-HISTORY-SECOND" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await controllerPane.sendInput(
    `${CONTROL} scrollback ${target.id} --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: wakeMarker }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, controller.id, { contains: '"recordType":"scrollback"' }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  await workbench.openTerminal({ id: target.id, name: target.name });
  await targetPane.expectConnected();
  await targetPane.sendInput(`${CONTROL} transcript ${controller.id}; echo "DENIED-EXIT=$?"`, true);
  await expectTerminalBuffer(page, target.id, { contains: "DENIED-EXIT=126" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  await workbench.openTerminal({ id: controller.id, name: controller.name });
  await controllerPane.sendInput(
    `${CONTROL} send ${target.id} --text exit --enter`,
    true,
  );
  const targetRow = page.locator(`.terminal-row[data-terminal-id="${target.id}"]`);
  await expect(targetRow.locator(".tree-status")).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  await controllerPane.sendInput(
    `${CONTROL} send ${target.id} --text 'echo SHOULD-NOT-BE-SENT' --enter`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: "terminal is not running" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await controllerPane.sendInput(
    `${CONTROL} transcript ${target.id} --from-sequence 0 --jsonl`,
    true,
  );
  await expectTerminalBuffer(page, controller.id, { contains: "CONTROL-HISTORY-SECOND" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
