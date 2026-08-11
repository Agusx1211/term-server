import type { Dir } from "node:fs";
import { open, opendir, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { ConsoleMessage, Page, TestInfo, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

export interface BrowserErrorLog {
  readonly kind: "console" | "pageerror" | "requestfailed" | "websocket";
  readonly timestamp: number;
  readonly message: string;
  readonly location?: string;
  readonly stack?: string;
}

export interface ArtifactRedactionOptions {
  readonly isolatedFixtureDir?: string;
  readonly generatedInputs?: readonly string[];
}

export interface FailureArtifactDetails {
  readonly server?: unknown;
  readonly page?: Page;
  readonly faultController?: unknown;
  readonly isolatedFixtureDir?: string;
  readonly generatedInputs?: readonly string[];
  readonly seed?: string | number;
  readonly faultSchedule?: unknown;
  readonly processList?: unknown;
  readonly includeVideo?: boolean;
}

type ErrorCollector = (() => readonly BrowserErrorLog[]) & { dispose: () => void };
type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };
type RecordLike = Record<string, unknown>;

const collectors = new WeakMap<Page, ErrorCollector>();
const sensitiveKey = /password|passwd|cookie|clipboard|authorization|set-cookie|terminalinput|rawinput|secret|token|apiKey|appKey|userKey/i;
const inputKey = /^(input|terminalInput|clipboard|clipboardText)$/i;
const transcriptPayloadKey = /^(?:payload|command|data|output|raw)(?:[_-]?base64)?$|^text$/i;
const sensitiveQueryKey = /password|passwd|cookie|clipboard|authorization|token|secret|key/i;
const absolutePath = /(?:^|[\s"'=:(])\/(?:home|Users|root|private|var|tmp|workspace|workspaces|worktree|app|opt)\/[A-Za-z0-9._~+@%=-]+(?:\/[A-Za-z0-9._~+@%=-]+)*/g;

const MAX_TRANSCRIPT_ATTACHMENT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_TOTAL_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 128;
const TRANSCRIPT_NOTICE_RESERVE_BYTES = 128;
const transcriptTruncationNotice = "\n[transcript truncated; showing head and tail]\n";
const transcriptAggregateNotice = "\n[additional transcript content omitted after the attachment limit]\n";

const generatedInputAllowed = (value: string, options: ArtifactRedactionOptions): boolean => options.generatedInputs?.some((input) => input === value) ?? false;

function redactPath(value: string, _options: ArtifactRedactionOptions): string {
  return value.replace(absolutePath, (candidate) => {
    const pathStart = candidate.search(/\/(?:home|Users|root|private|var|tmp|workspace|workspaces|worktree|app|opt)\//);
    const path = pathStart >= 0 ? candidate.slice(pathStart) : candidate;
    return path ? "[REDACTED_PATH]" : candidate;
  });
}

function redactUrl(value: string, options: ArtifactRedactionOptions): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return redactPath(url.toString(), options);
  } catch {
    return redactPath(value, options);
  }
}

export function redactText(value: string, options: ArtifactRedactionOptions = {}): string {
  let redacted = value;
  redacted = redacted.replace(/((?:password|passwd|cookie|clipboard|authorization|set-cookie|token|secret)\s*[:=]\s*)(["']?)([^\s,"'};]+)\2/gi, "$1[REDACTED]");
  redacted = redacted.replace(/(Bearer\s+|Basic\s+)[^\s,;]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(/(input|terminalInput|clipboard(?:Text)?)\s*[:=]\s*(["'])(.*?)\2/gi, "$1: [REDACTED]");
  redacted = redacted.replace(/(["'])((?:payload|command|data|output|raw)(?:[_-]?base64)?|text)\1(\s*[:=]\s*)(["'])([\s\S]*?)\4/gi, "$1$2$1$3$4[REDACTED]$4");
  redacted = redacted.replace(/\b((?:payload|command|data|output|raw)(?:[_-]?base64)?)\b(\s*[:=]\s*)(["'])([\s\S]*?)\3/gi, "$1$2$3[REDACTED]$3");
  redacted = redactPath(redacted, options);
  return redacted;
}

export function redactValue(value: unknown, options: ArtifactRedactionOptions = {}, key?: string): unknown {
  if (key && typeof value === "string" && transcriptPayloadKey.test(key)) return "[REDACTED]";
  if (key && sensitiveKey.test(key)) {
    if (key && inputKey.test(key) && typeof value === "string" && generatedInputAllowed(value, options)) return value;
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, options),
      stack: value.stack ? redactText(value.stack, options) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, options));
  if (typeof value === "object") {
    const result: RecordLike = {};
    for (const [entryKey, entryValue] of Object.entries(value)) result[entryKey] = redactValue(entryValue, options, entryKey);
    return result;
  }
  return "[REDACTED]";
}


export function redactJson(value: unknown, options: ArtifactRedactionOptions = {}): string {
  try {
    return JSON.stringify(redactValue(value, options), null, 2);
  } catch {
    return "{\"error\":\"unserializable artifact value\"}";
  }
}

const consoleLocation = (message: ConsoleMessage): string | undefined => {
  const location = message.location();
  return location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined;
};
export function installBrowserErrorCollectors(page: Page): ErrorCollector {
  const existing = collectors.get(page);
  if (existing) return existing;
  const logs: BrowserErrorLog[] = [];
  const options: ArtifactRedactionOptions = {};
  const push = (entry: BrowserErrorLog): void => {
    logs.push({
      ...entry,
      message: redactText(entry.message, options),
      location: entry.location ? redactUrl(entry.location, options) : undefined,
      stack: entry.stack ? redactText(entry.stack, options) : undefined,
    });
  };
  const onConsole = (message: ConsoleMessage): void => {
    push({ kind: "console", timestamp: Date.now(), message: `${message.type()}: ${message.text()}`, location: consoleLocation(message) });
  };
  const onPageError = (error: Error): void => {
    push({ kind: "pageerror", timestamp: Date.now(), message: error.message, stack: error.stack });
  };
  const onRequestFailed = (request: { url(): string; failure(): { errorText?: string } | null }): void => {
    push({ kind: "requestfailed", timestamp: Date.now(), message: request.failure()?.errorText ?? "request failed", location: request.url() });
  };
  const onWebSocket = (socket: PlaywrightWebSocket): void => {
    push({ kind: "websocket", timestamp: Date.now(), message: "opened", location: socket.url() });
    try {
      socket.on("close", () => push({ kind: "websocket", timestamp: Date.now(), message: "closed", location: socket.url() }));
    } catch {
      // Some browser adapters do not expose close events; the opening record is enough.
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("websocket", onWebSocket);
  let disposed = false;
  const collector = (() => logs.map((entry) => ({ ...entry }))) as unknown as ErrorCollector;
  collector.dispose = () => {
    if (disposed) return;
    disposed = true;
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("websocket", onWebSocket);
  };
  collectors.set(page, collector);
  return collector;
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown, options: ArtifactRedactionOptions): Promise<void> {
  await testInfo.attach(name, { body: redactJson(value, options), contentType: "application/json" });
}

async function attachText(testInfo: TestInfo, name: string, value: string, options: ArtifactRedactionOptions): Promise<void> {
  await testInfo.attach(name, { body: redactText(value, options), contentType: "text/plain" });
}

async function attachPathIfSafe(
  testInfo: TestInfo,
  name: string,
  value: unknown,
  options: ArtifactRedactionOptions,
): Promise<void> {
  if (typeof value !== "string") return;
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) return;
  const fixture = options.isolatedFixtureDir ? resolve(options.isolatedFixtureDir) : undefined;
  if (!fixture || (resolved !== fixture && !resolved.startsWith(`${fixture}/`))) return;
  try {
    const content = await readFile(resolved);
    await testInfo.attach(name, { body: Buffer.from(redactText(content.toString("utf8"), options)), contentType: "text/plain" });
  } catch {
    // Cleanup can race artifact collection; the remaining artifacts are still useful.
  }
}
type TranscriptBudget = {
  remainingBytes: number;
  readonly directories: Set<string>;
  readonly files: Set<string>;
  omitted: boolean;
  noticeAttached: boolean;
};

function limitTranscriptText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const noticeBytes = Buffer.byteLength(transcriptTruncationNotice, "utf8");
  if (maxBytes <= noticeBytes) return Buffer.from(transcriptTruncationNotice, "utf8").subarray(0, maxBytes).toString("utf8");
  const available = maxBytes - noticeBytes;
  const headBytes = Math.ceil(available / 2);
  const tailBytes = available - headBytes;
  return `${bytes.subarray(0, headBytes).toString("utf8")}${transcriptTruncationNotice}${bytes.subarray(bytes.length - tailBytes).toString("utf8")}`;
}

async function readBoundedTranscript(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const size = typeof stat.size === "number" && Number.isFinite(stat.size) ? stat.size : Number.MAX_SAFE_INTEGER;
    const limit = Math.min(MAX_TRANSCRIPT_ATTACHMENT_BYTES, Math.max(0, maxBytes));
    if (limit === 0 || size === 0) return "";
    const readAt = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const result = await handle.read(buffer, offset, length - offset, position + offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return buffer.subarray(0, offset);
    };
    if (size <= limit) return (await readAt(0, size)).toString("utf8");
    const noticeBytes = Buffer.byteLength(transcriptTruncationNotice, "utf8");
    if (limit <= noticeBytes) return transcriptTruncationNotice.slice(0, limit);
    const available = limit - noticeBytes;
    const headBytes = Math.ceil(available / 2);
    const tailBytes = available - headBytes;
    const head = await readAt(0, headBytes);
    const tail = await readAt(Math.max(0, size - tailBytes), tailBytes);
    return `${head.toString("utf8")}${transcriptTruncationNotice}${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function attachBoundedTranscript(
  testInfo: TestInfo,
  name: string,
  value: string,
  options: ArtifactRedactionOptions,
  budget: TranscriptBudget,
): Promise<void> {
  if (budget.remainingBytes <= 0) return;
  const body = limitTranscriptText(redactText(value, options), budget.remainingBytes);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes === 0) return;
  await testInfo.attach(name, { body, contentType: "text/plain" });
  budget.remainingBytes -= bytes;
}

async function attachTranscriptDirectory(
  testInfo: TestInfo,
  name: string,
  value: unknown,
  options: ArtifactRedactionOptions,
  budget: TranscriptBudget,
): Promise<void> {
  if (typeof value !== "string") return;
  const resolved = resolve(value);
  if (budget.directories.has(resolved)) return;
  const fixture = options.isolatedFixtureDir ? resolve(options.isolatedFixtureDir) : undefined;
  const environmentTranscript = typeof process !== "undefined" ? process.env.TERM_SERVER_FIXTURE_TRANSCRIPT_DIR : undefined;
  const environmentDirectory = environmentTranscript ? resolve(environmentTranscript) : undefined;
  const harnessTranscript = resolved.includes("/artifacts/e2e/");
  if (!isAbsolute(resolved) || (!harnessTranscript && resolved !== environmentDirectory && (!fixture || !resolved.startsWith(`${fixture}/`)))) return;
  budget.directories.add(resolved);
  let directory: Dir | undefined;
  try {
    directory = await opendir(resolved);
    let fileCount = 0;
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (fileCount >= MAX_TRANSCRIPT_FILES || budget.remainingBytes <= TRANSCRIPT_NOTICE_RESERVE_BYTES) {
        budget.omitted = true;
        break;
      }
      fileCount += 1;
      const path = resolve(resolved, entry.name);
      if (budget.files.has(path)) continue;
      budget.files.add(path);
      try {
        const content = await readBoundedTranscript(path, Math.min(MAX_TRANSCRIPT_ATTACHMENT_BYTES, budget.remainingBytes - TRANSCRIPT_NOTICE_RESERVE_BYTES));
        await attachBoundedTranscript(testInfo, `${name}-${basename(entry.name)}`, content, options, budget);
      } catch {
        // Cleanup can race artifact collection; the remaining artifacts are still useful.
      }
    }
    if (fileCount >= MAX_TRANSCRIPT_FILES) budget.omitted = true;
  } catch {
    // Cleanup can race artifact collection; the remaining artifacts are still useful.
  } finally {
    try {
      await directory?.close();
    } catch {
      // The async iterator may already have closed the directory.
    }
  }
}

async function collectDiagnostics(page: Page, options: ArtifactRedactionOptions): Promise<unknown> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) return { available: false };
    return {
      available: true,
      version: api.version,
      terminals: api.terminals(),
      events: api.events(),
    };
  }).then((value) => redactValue(value, options));
}

async function collectFaultSchedule(faultController: unknown, options: ArtifactRedactionOptions): Promise<unknown> {
  if (!faultController || typeof faultController !== "object") return undefined;
  const source = faultController as RecordLike;
  try {
    const events = source.events;
    if (Array.isArray(events)) return redactValue(events, options);
  } catch {
    return { error: "fault controller events unavailable" };
  }
  for (const method of ["snapshot", "schedule", "log"]) {
    const candidate = source[method];
    if (typeof candidate !== "function") continue;
    try {
      return redactValue(await (candidate as () => unknown)(), options);
    } catch {
      return { error: `fault controller ${method} unavailable` };
    }
  }
  return redactValue(source, options);
}

/** Attach §18 failure evidence using Playwright TestInfo attachments (trace-compatible). */
export async function attachFailureArtifacts(
  testInfo: TestInfo,
  details: FailureArtifactDetails = {},
): Promise<void> {
  const options: ArtifactRedactionOptions = {
    isolatedFixtureDir: details.isolatedFixtureDir
      ?? (typeof process !== "undefined" ? process.env.TERM_SERVER_FIXTURE_TRANSCRIPT_DIR : undefined),
    generatedInputs: details.generatedInputs,
  };
  const transcriptBudget: TranscriptBudget = {
    remainingBytes: MAX_TRANSCRIPT_TOTAL_BYTES,
    directories: new Set<string>(),
    files: new Set<string>(),
    omitted: false,
    noticeAttached: false,
  };
  const page = details.page;
  if (page) {
    try {
      await testInfo.attach("failure-full-page", {
        body: await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }),
        contentType: "image/png",
      });
    } catch {
      // A closed page may not have a screenshot; diagnostics below can still be attached.
    }
    try {
      const terminal = page.locator("section[role=region][data-terminal-id]").first();
      if (await terminal.count()) {
        await testInfo.attach("failure-terminal-crop", {
          body: await terminal.screenshot({ animations: "disabled", caret: "hide" }),
          contentType: "image/png",
        });
      }
    } catch {
      // The terminal may have been disposed during failure cleanup.
    }
    try {
      const collector = collectors.get(page);
      await attachJson(testInfo, "browser-console-and-page-errors", collector ? collector() : [], options);
    } catch {
      // Do not mask the original test failure with an attachment error.
    }
    try {
      await attachJson(testInfo, "terminal-diagnostics", await collectDiagnostics(page, options), options);
    } catch {
      // Diagnostics are intentionally unavailable in normal production builds.
    }
    try {
      await attachText(testInfo, "network-websocket-log", JSON.stringify(collectors.get(page)?.() ?? []), options);
    } catch {
      // Best-effort artifact.
    }
    if (details.includeVideo) {
      try {
        const videoPath = await page.video()?.path();
        if (videoPath) await testInfo.attach("failure-video", { path: videoPath, contentType: "video/webm" });
      } catch {
        // Video is optional and may not be configured.
      }
    }
  }

  const server = details.server;
  const serverRecord = server && typeof server === "object" ? server as RecordLike : undefined;
  if (serverRecord) {
    for (const [key, artifactName] of [["serverLogs", "server-logs"], ["brokerLogs", "broker-logs"], ["stdout", "server-stdout"], ["stderr", "server-stderr"]] as const) {
      const value = serverRecord[key];
      if (typeof value !== "string") continue;
      if (value.includes("\n")) await attachText(testInfo, artifactName, value, options);
      else await attachPathIfSafe(testInfo, artifactName, value, options);
    }
    for (const [key, artifactName] of [["fixtureTranscript", "fixture-transcript"], ["transcriptDir", "fixture-transcript"]] as const) {
      await attachTranscriptDirectory(testInfo, artifactName, serverRecord[key], options, transcriptBudget);
    }
    await attachJson(testInfo, "server-details", server, options);
  }
  if (details.faultController) {
    await attachJson(testInfo, "fault-injection-schedule", await collectFaultSchedule(details.faultController, options), options);
  }
  if (details.seed !== undefined || details.faultSchedule !== undefined) {
    await attachJson(testInfo, "test-seed-and-fault-schedule", {
      seed: details.seed,
      faultSchedule: details.faultSchedule,
    }, options);
  }
  if (details.processList !== undefined) await attachJson(testInfo, "harness-process-list", details.processList, options);

  const transcriptPath = typeof process !== "undefined" ? process.env.TERM_SERVER_FIXTURE_TRANSCRIPT_DIR : undefined;
  if (transcriptPath) await attachTranscriptDirectory(testInfo, "fixture-transcript", transcriptPath, options, transcriptBudget);
  if (transcriptBudget.omitted && transcriptBudget.remainingBytes > 0 && !transcriptBudget.noticeAttached) {
    transcriptBudget.noticeAttached = true;
    await attachBoundedTranscript(testInfo, "fixture-transcript-truncated", transcriptAggregateNotice, options, transcriptBudget);
  }
}

export type { ErrorCollector as BrowserErrorCollector };
