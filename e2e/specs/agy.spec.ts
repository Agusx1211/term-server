import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { SidebarPage } from "../pages/sidebar-page.js";

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

test("Antigravity hooks drive broker status and terminal-scoped access @p0 @packaged", async ({ page, server, baseURL }) => {
  const hooks = JSON.parse(await readFile("integrations/agy/hooks.json", "utf8"))["term-server-agent-events"];
  const hook = (name: string, tool = "run_command"): string => {
    const group = hooks[name][0];
    const command = (group.hooks?.[0] ?? group).command as string;
    const payload = JSON.stringify({
      conversationId: "agy-fixture", stepIdx: 1,
      toolCall: { name: tool, args: { CommandLine: "true" } },
    });
    return `printf '%s' ${quote(payload)} | sh -c ${quote(command)}`;
  };
  const accessResult = join(server.dataDir, "agy-access-result");
  const executable = join(server.dataDir, "agy");
  await writeFile(executable, String.raw`#!/bin/sh
${hook("PreInvocation")}
printf 'AGY_READY\n'
while IFS= read -r action; do
  case "$action" in
    approval) printf '\033[2J\033[HRun command?\ny Approve\nn Reject\n' ;;
    question) printf '\033[2J\033[H'; ${hook("PreToolUse", "ask_question")} ;;
    resume) printf '\033[2J\033[H'; ${hook("PostToolUse")}; printf 'AGY_RESUMED\n' ;;
    stop) printf '\033[2J\033[H'; ${hook("Stop")}; printf 'AGY_STOPPED\n' ;;
    access) "$TERM_SERVER_EXECUTABLE" access secret list --agent agy >/dev/null; printf '%s' "$?" > ${quote(accessResult)} ;;
    quit) exit 0 ;;
  esac
done
`, { mode: 0o700 });

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const terminal = await page.evaluate(async () => {
    const response = await fetch("/api/terminals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "/bin/sh" }),
    });
    if (!response.ok) throw new Error(`terminal creation failed: ${response.status}`);
    return await response.json() as { id: string; name: string };
  });
  await page.reload();
  const pane = await new SidebarPage(page).openTerminal({ id: terminal.id });
  await pane.expectConnected();
  await pane.sendInput(quote(executable), true);
  const agent = async () => page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    const terminals = await response.json() as Array<{ id: string; agent?: { kind: string; status: string } }>;
    return terminals.find((terminal) => terminal.id === id)?.agent;
  }, terminal.id);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "working" });
  await pane.sendInput("approval", true);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "blocked" });
  await expect(pane.root.locator(".pane-activity-state")).toContainText("Needs you");
  await pane.sendInput("resume", true);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "working" });
  await pane.sendInput("question", true);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "blocked" });
  await pane.sendInput("stop", true);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "idle" });
  await pane.sendInput("access", true);
  await expect.poll(async () => readFile(accessResult, "utf8").catch(() => "pending")).toBe("0");
  await pane.sendInput("quit", true);
  await expect.poll(agent).toMatchObject({ kind: "agy", status: "closed" });
});
