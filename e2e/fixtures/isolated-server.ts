import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { NetworkFaultController } from "./network-faults.js";

export const E2E_SERVER_PASSWORD = "e2e-development";
export const E2E_SERVER_HOST = "127.0.0.1";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIRECTORY_PREFIX = "term-server-e2e-";

export interface TranscriptEntry {
  [key: string]: unknown;
}

export type TranscriptPredicate<T extends TranscriptEntry = TranscriptEntry> = (
  entry: TranscriptEntry,
  entries: readonly TranscriptEntry[],
) => boolean;

export interface WaitForTranscriptOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IsolatedServerOptions {
  workerIndex?: number;
  projectName?: string;
  startupTimeoutMs?: number;
  artifactDirectory?: string;
  binaryPath?: string;
  clientDirectory?: string;
  fixturePath?: string;
}

export interface IsolatedServerSnapshot {
  readonly dataDir: string;
  readonly transcriptDir: string;
  readonly internalOrigin: string;
  readonly targetOrigin: string;
  readonly baseURL: string;
  readonly port: number;
  readonly proxyPort: number;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const parentPath = normalize(resolve(parent));
  const candidatePath = normalize(resolve(candidate));
  const child = relative(parentPath, candidatePath);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function safeTerminalId(terminalId: string): string {
  if (!terminalId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(terminalId)) {
    throw new Error(`invalid terminal id for transcript lookup: ${JSON.stringify(terminalId)}`);
  }
  return terminalId;
}

async function pathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      listener.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      listener.off("error", onError);
      resolvePromise();
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen({ host: E2E_SERVER_HOST, port: 0 });
  });
  const address = listener.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolvePromise()));
  });
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`OS did not assign a valid loopback port (received ${port})`);
  }
  return port;
}

async function makeSafeDataDirectory(workerIndex: number): Promise<{ path: string; marker: string }> {
  const temporaryRoot = await realpath(tmpdir());
  const userDataDirectory = resolve(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "term-server",
  );
  const configuredDataDirectory = process.env.TERM_SERVER_DATA_DIR
    ? resolve(process.env.TERM_SERVER_DATA_DIR)
    : undefined;
  const createdPath = await mkdtemp(join(temporaryRoot, `${DATA_DIRECTORY_PREFIX}${workerIndex}-`));
  let path = createdPath;
  try {
    path = await realpath(createdPath);
    if (!isAbsolute(path) || path === "/" || path.trim() === "") {
      throw new Error(`refusing unsafe E2E data directory ${JSON.stringify(path)}`);
    }
    if (path === userDataDirectory || pathIsWithin(userDataDirectory, path)) {
      throw new Error(`E2E data directory points at the user data directory: ${path}`);
    }
    if (configuredDataDirectory && (path === configuredDataDirectory || pathIsWithin(configuredDataDirectory, path))) {
      throw new Error(`E2E data directory overlaps TERM_SERVER_DATA_DIR: ${path}`);
    }
    if (path === REPOSITORY_ROOT || pathIsWithin(REPOSITORY_ROOT, path)) {
      throw new Error(`E2E data directory overlaps the repository: ${path}`);
    }
    if (!pathIsWithin(temporaryRoot, path)) {
      throw new Error(`E2E data directory is outside the OS temporary directory: ${path}`);
    }

    const marker = join(path, ".term-server-e2e-owner");
    const owner = JSON.stringify({ pid: process.pid, workerIndex, token: randomUUID() });
    const markerHandle = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await markerHandle.writeFile(owner, "utf8");
    } finally {
      await markerHandle.close();
    }
    return { path, marker };
  } catch (error) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      // Preserve the safety/startup error even if cleanup is unavailable.
    }
    throw error;
  }
}

async function validateExecutable(path: string, label: string): Promise<string> {
  const absolutePath = isAbsolute(path) ? path : resolve(REPOSITORY_ROOT, path);
  try {
    const details = await stat(absolutePath);
    if (!details.isFile()) throw new Error(`${label} is not a file`);
  } catch (error) {
    throw new Error(`${label} not found at ${absolutePath}: ${(error as Error).message}`);
  }
  return absolutePath;
}

async function validateClientDirectory(path: string): Promise<string> {
  const absolutePath = isAbsolute(path) ? path : resolve(REPOSITORY_ROOT, path);
  try {
    const details = await stat(join(absolutePath, "index.html"));
    if (!details.isFile()) throw new Error("index.html is not a file");
  } catch (error) {
    throw new Error(`production E2E client bundle not found at ${absolutePath}: ${(error as Error).message}`);
  }
  return absolutePath;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const parentExited = child.exitCode !== null || child.signalCode !== null;
  const pid = child.pid;
  if (!pid || (parentExited && process.platform === "win32")) return;
  let signalled = false;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      signalled = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!signalled) child.kill("SIGTERM");
  if (parentExited || await waitForExit(child, 5_000)) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForExit(child, 5_000);
}

function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        entries.push(value as TranscriptEntry);
      }
    } catch {
      // Tolerate a partial final line until the fixture emits the next change.
    }
  }
  return entries;
}

export class IsolatedServer implements IsolatedServerSnapshot {
  readonly workerIndex: number;
  readonly projectName: string;
  readonly startupTimeoutMs: number;
  readonly artifactDirectory: string;
  readonly binaryPath: string;
  readonly clientDirectory: string;
  readonly fixturePath: string;

  dataDir = "";
  transcriptDir = "";
  internalOrigin = "";
  targetOrigin = "";
  baseURL = "";
  port = 0;
  proxyPort = 0;
  process: ChildProcessWithoutNullStreams | undefined;
  faultController: NetworkFaultController | undefined;

  private ownerMarker = "";
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private spawnError: Error | undefined;
  private exitPromise: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(options: IsolatedServerOptions = {}) {
    this.workerIndex = options.workerIndex ?? 0;
    this.projectName = options.projectName ?? "e2e";
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.artifactDirectory = resolve(options.artifactDirectory ?? join(REPOSITORY_ROOT, "artifacts", "e2e"));
    this.binaryPath = options.binaryPath ?? process.env.TERM_SERVER_E2E_BINARY ?? join(REPOSITORY_ROOT, "target", "release", "term-server");
    this.clientDirectory = options.clientDirectory ?? process.env.TERM_SERVER_E2E_CLIENT_DIR ?? join(REPOSITORY_ROOT, "dist", "client");
    this.fixturePath = options.fixturePath ?? process.env.TERM_SERVER_E2E_FIXTURE ?? join(REPOSITORY_ROOT, "target", "release", "e2e-pty-fixture");
  }

  get stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }

  get stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  async start(): Promise<this> {
    if (this.started) return this;
    if (this.stopping) throw new Error("cannot start an E2E server while it is stopping");
    this.started = true;
    try {
      const dataDirectory = await makeSafeDataDirectory(this.workerIndex);
      this.dataDir = dataDirectory.path;
      this.ownerMarker = dataDirectory.marker;
      this.transcriptDir = join(this.dataDir, "transcripts");
      await mkdir(this.transcriptDir, { recursive: true, mode: 0o700 });
      this.port = await reserveLoopbackPort();
      this.internalOrigin = `http://${E2E_SERVER_HOST}:${this.port}`;
      this.targetOrigin = this.internalOrigin;

      this.faultController = new NetworkFaultController({ targetOrigin: this.internalOrigin });
      const proxy = await this.faultController.start();
      this.baseURL = proxy.origin;
      this.proxyPort = proxy.port;
      if (!this.baseURL || !Number.isInteger(this.proxyPort) || this.proxyPort <= 0) {
        throw new Error("network fault controller did not return a valid proxy origin and port");
      }

      const binary = await validateExecutable(this.binaryPath, "term-server binary");
      const client = await validateClientDirectory(this.clientDirectory);
      const fixture = await validateExecutable(this.fixturePath, "E2E PTY fixture");
      const temporaryDirectory = join(this.dataDir, "tmp");
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        TERM_SERVER_PASSWORD: E2E_SERVER_PASSWORD,
        TERM_SERVER_NO_HTTPS: "true",
        TERM_SERVER_DATA_DIR: this.dataDir,
        TERM_SERVER_CLIENT_DIR: client,
        TERM_SERVER_SHELL: fixture,
        TERM_SERVER_FIXTURE_TRANSCRIPT_DIR: this.transcriptDir,
        TERM_SERVER_HOST: E2E_SERVER_HOST,
        TERM_SERVER_PORT: String(this.port),
        TERM_SERVER_ALLOWED_ORIGINS: this.baseURL,
        TERM_SERVER_DISABLE_UPDATES: "true",
        TERM_SERVER_NO_STATUS_AUTO: "true",
        TMPDIR: temporaryDirectory,
        TMP: temporaryDirectory,
        TEMP: temporaryDirectory,
        TERM_SERVER_LOG: "term_server=info,tower_http=info",
      };

      const child = (this.process = spawn(binary, [], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      }) as unknown as ChildProcessWithoutNullStreams);
      child.once("error", (error) => {
        this.spawnError = error;
      });
      child.stdout.on("data", (chunk: Buffer | string) => this.stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer | string) => this.stderrChunks.push(Buffer.from(chunk)));
      this.exitPromise = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
      await this.waitUntilReady();
      return this;
    } catch (error) {
      const primaryError = error instanceof Error ? error : new Error(String(error));
      let cleanupError: unknown;
      try {
        await this.stop();
      } catch (candidate) {
        cleanupError = candidate;
      }
      const cleanupMessage = cleanupError instanceof Error
        ? `\nE2E cleanup also failed: ${cleanupError.message}`
        : "";
      throw new Error(`${primaryError.message}${cleanupMessage}\n${this.logSummary()}`, { cause: primaryError });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      if (this.process) await terminateChild(this.process);
      if (this.exitPromise) await this.exitPromise;
      await this.faultController?.stop();
    } finally {
      this.process = undefined;
      await this.removeOwnedDataDirectory();
    }
  }

  transcriptPath(terminalId: string): string {
    if (!this.transcriptDir) throw new Error("E2E server has not started");
    return join(this.transcriptDir, `${safeTerminalId(terminalId)}.jsonl`);
  }

  async readTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string): Promise<T[]> {
    try {
      return parseTranscript(await readFile(this.transcriptPath(terminalId), "utf8")) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(
    terminalId: string,
    predicate: TranscriptPredicate<T>,
    options: WaitForTranscriptOptions = {},
  ): Promise<T> {
    const transcriptPath = this.transcriptPath(terminalId);
    const transcriptFileName = `${safeTerminalId(terminalId)}.jsonl`;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a finite positive number");
    if (options.signal?.aborted) throw new DOMException("The wait was aborted", "AbortError");

    let watcher: FSWatcher | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let checkRunning = false;
    let checkAgain = false;
    let finishResolve!: (entry: T) => void;
    let finishReject!: (error: unknown) => void;
    const abort = () => finishReject(new DOMException("The wait was aborted", "AbortError"));
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      watcher?.close();
      options.signal?.removeEventListener("abort", abort);
    };
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      finishResolve = (entry) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(entry);
      };
      finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };
    });

    const check = async () => {
      if (settled) return;
      if (checkRunning) {
        checkAgain = true;
        return;
      }
      checkRunning = true;
      try {
        const entries = await this.readTranscript<T>(terminalId);
        for (const entry of entries) {
          if (predicate(entry, entries)) {
            finishResolve(entry);
            break;
          }
        }
      } catch (error) {
        finishReject(error);
      } finally {
        checkRunning = false;
        if (checkAgain && !settled) {
          checkAgain = false;
          void check();
        }
      }
    };

    try {
      watcher = watch(this.transcriptDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || String(filename) === transcriptFileName) void check();
      });
      watcher.on("error", finishReject);
    } catch (error) {
      finishReject(error);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      finishReject(new Error(`timed out waiting for transcript ${transcriptPath}`));
    }, timeoutMs);
    void check();
    return result;
  }

  logSummary(): string {
    return `term-server stdout:\n${this.stdout}\nterm-server stderr:\n${this.stderr}`;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw new Error(`failed to launch term-server: ${this.spawnError.message}`);
      if (this.process && (this.process.exitCode !== null || this.process.signalCode !== null)) {
        throw new Error(`term-server exited before health readiness (code=${this.process.exitCode ?? "none"}, signal=${this.process.signalCode ?? "none"})`);
      }
      try {
        const response = await fetch(`${this.internalOrigin}/healthz`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const proxyResponse = await fetch(`${this.baseURL}/healthz`, { signal: AbortSignal.timeout(1_000) });
          if (proxyResponse.ok) return;
        }
      } catch {
        // The server may still be binding or the proxy may still be connecting.
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`term-server did not become healthy within ${this.startupTimeoutMs}ms`);
  }

  private async removeOwnedDataDirectory(): Promise<void> {
    if (!this.dataDir || !this.ownerMarker) return;
    const markerPath = await pathIfExists(this.ownerMarker);
    const dataPath = await pathIfExists(this.dataDir);
    if (!markerPath || !dataPath || dataPath !== resolve(this.dataDir)) return;
    if (!pathIsWithin(tmpdir(), dataPath)) return;
    try {
      await rm(dataPath, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function launchIsolatedServer(options: IsolatedServerOptions = {}): Promise<IsolatedServer> {
  const server = new IsolatedServer(options);
  await server.start();
  return server;
}

export const startIsolatedServer = launchIsolatedServer;
