import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { URL } from "node:url";

export type NetworkFaultDirection =
  | "browser-to-server"
  | "server-to-browser"
  | "client-to-server"
  | "server-to-client";
export type NetworkDirection = NetworkFaultDirection;
export type NetworkFaultWhen = "before" | "after";

export interface NetworkFaultMatcher {
  path?: string | RegExp;
  url?: string | RegExp;
  terminalUrl?: string | RegExp;
  terminalId?: string;
  generation?: number;
  direction?: NetworkFaultDirection;
  jsonType?: string;
  controlType?: string;
  kind?: number;
  binaryKind?: number;
  sequence?: number | bigint;
  occurrence?: number;
}

export interface NetworkConnectionMetadata {
  readonly id: number;
  readonly path: string;
  readonly terminalId?: string;
  readonly generation: number;
}

export interface NetworkFrameMetadata {
  readonly opcode: number;
  readonly fin: boolean;
  readonly bytes: number;
  readonly jsonType?: string;
  readonly binaryKind?: number;
  readonly sequence?: number;
  readonly sequenceUnsafe?: boolean;
  readonly occurrence: number;
}

export type NetworkFaultEventType =
  | "proxy-started"
  | "proxy-stopped"
  | "http-request"
  | "http-response"
  | "upgrade-request"
  | "upgrade-open"
  | "upgrade-delay"
  | "connection-open"
  | "connection-closed"
  | "connection-terminated"
  | "socket-error"
  | "frame"
  | "malformed-frame"
  | "paused"
  | "resumed"
  | "throttled"
  | "dropped"
  | "restored"
  | "close-sent"
  | "terminated"
  | "injected";

/** Events contain metadata only; payloads, cookies, and authorization headers never enter this log. */
export interface NetworkFaultEvent {
  readonly type: NetworkFaultEventType;
  readonly at: number;
  readonly connectionId?: number;
  readonly path?: string;
  readonly terminalId?: string;
  readonly generation?: number;
  readonly direction?: "browser-to-server" | "server-to-browser";
  readonly bytes?: number;
  readonly statusCode?: number;
  readonly code?: number;
  readonly abrupt?: boolean;
  readonly frame?: NetworkFrameMetadata;
  readonly ruleId?: string;
}

export interface NetworkFaultControllerOptions {
  targetOrigin: string;
  host?: string;
  eventLogLimit?: number;
}

export interface NetworkFaultCloseOptions {
  code: number;
  reason?: string;
  direction?: NetworkFaultDirection;
  matcher?: NetworkFaultMatcher;
  when?: NetworkFaultWhen;
}

export interface NetworkFaultInjectOptions {
  direction: NetworkFaultDirection;
  data: string | Uint8Array;
  binary?: boolean;
  matcher?: NetworkFaultMatcher;
  when?: NetworkFaultWhen;
  raw?: boolean;
}

export interface NetworkFaultMalformedFrameOptions {
  direction: NetworkFaultDirection;
  data: Uint8Array;
  matcher?: NetworkFaultMatcher;
  when?: NetworkFaultWhen;
}

export interface NetworkFaultAddress {
  readonly origin: string;
  readonly port: number;
}

export type NetworkFaultDisposer = (() => void) & {
  readonly id: string;
  dispose(): void;
};

export type NetworkFaultEventPredicate =
  | ((event: NetworkFaultEvent) => boolean)
  | NetworkFaultEventType;

export interface NetworkFaultWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface InternalRule {
  readonly id: string;
  readonly action: "delay-upgrade" | "pause" | "throttle" | "close" | "terminate" | "drop" | "inject";
  readonly direction?: "browser-to-server" | "server-to-browser";
  readonly matcher?: NetworkFaultMatcher;
  readonly code?: number;
  readonly reason?: string;
  readonly when?: NetworkFaultWhen;
  readonly bytesPerSecond?: number;
  readonly delayMs?: number;
  readonly data?: Buffer;
  readonly binary?: boolean;
  readonly raw?: boolean;
  readonly malformed?: boolean;
}

interface ParsedWebSocketFrame {
  readonly raw: Buffer;
  readonly payload: Buffer;
  readonly opcode: number;
  readonly fin: boolean;
}

interface ParsedFrameBatch {
  readonly frames: ParsedWebSocketFrame[];
  readonly malformed?: Buffer;
}

interface DirectionState {
  readonly parser: WebSocketFrameParser;
  readonly queue: Buffer[];
  paused: boolean;
  dropped: boolean;
  bytesPerSecond?: number;
  pumping: boolean;
  timer?: NodeJS.Timeout;
}

interface ProxyConnection {
  readonly id: number;
  readonly path: string;
  readonly requestUrl: string;
  readonly terminalId?: string;
  readonly generation: number;
  readonly client: net.Socket;
  target?: net.Socket;
  readonly browser: DirectionState;
  readonly server: DirectionState;
  readonly timers: Set<NodeJS.Timeout>;
  readonly firedRules: Set<string>;
  readonly activatedRules: Set<string>;
  readonly occurrences: Map<string, number>;
  readonly closeCodes: Partial<Record<"browser" | "server", number>>;
  handshakeOpen: boolean;
  handshakeResponseSeen: boolean;
  handshakeBuffer: Buffer;
  pendingBrowser: Buffer[];
  pendingServer: Buffer[];
  handshakeTimer?: NodeJS.Timeout;
  closed: boolean;
  closing: boolean;
  terminated: boolean;
  gracefulCloseCode?: number;
}

interface InternalFrameMetadata extends NetworkFrameMetadata {
  readonly frameCode?: number;
  readonly sequenceBigInt?: bigint;
}

interface Waiter {
  readonly predicate: (event: NetworkFaultEvent) => boolean;
  readonly resolve: (event: NetworkFaultEvent) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
}

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_EVENT_LOG_LIMIT = 512;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_UPGRADE_DELAY_MS = 500;
const GRACEFUL_CLOSE_TIMEOUT_MS = 250;
const MAX_CLOSE_REASON_BYTES = 123;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function canonicalDirection(direction: NetworkFaultDirection): "browser-to-server" | "server-to-browser" {
  return direction === "browser-to-server" || direction === "client-to-server" ? "browser-to-server" : "server-to-browser";
}

function globMatches(value: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matcherHasFrameFields(matcher: NetworkFaultMatcher | undefined): boolean {
  return matcher?.jsonType !== undefined || matcher?.controlType !== undefined || matcher?.binaryKind !== undefined || matcher?.kind !== undefined || matcher?.sequence !== undefined || matcher?.occurrence !== undefined;
}

function closeCodeIsValid(code: number): boolean {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code);
}

function normalizeCloseReason(reason: string | undefined): Buffer {
  return reason ? Buffer.from(reason).subarray(0, MAX_CLOSE_REASON_BYTES) : Buffer.alloc(0);
}

function appendPath(base: string, path: string): string {
  const normalizedBase = base === "/" ? "" : base.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}` || "/";
}

function pathName(requestUrl: string): string {
  try {
    return new URL(requestUrl, "http://term-server.invalid").pathname || "/";
  } catch {
    const question = requestUrl.indexOf("?");
    return (question < 0 ? requestUrl : requestUrl.slice(0, question)) || "/";
  }
}

function terminalIdFromPath(path: string): string | undefined {
  const match = /\/terminals\/([^/]+)/.exec(path);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function generationFromUrl(requestUrl: string): number | undefined {
  try {
    const url = new URL(requestUrl, "http://term-server.invalid");
    const value = url.searchParams.get("generation") ?? url.searchParams.get("gen");
    if (value === null) return undefined;
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined;
  } catch {
    return undefined;
  }
}

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf("\r\n\r\n");
}

function asBuffer(data: string | Uint8Array): Buffer {
  return typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
}

function encodeDataFrame(payload: Uint8Array, binary: boolean, mask: boolean, maskSeed: number): Buffer {
  const body = Buffer.from(payload);
  const header: number[] = [0x80 | (binary ? 0x2 : 0x1)];
  if (body.length < 126) header.push((mask ? 0x80 : 0) | body.length);
  else if (body.length <= 0xffff) header.push((mask ? 0x80 : 0) | 126, (body.length >>> 8) & 0xff, body.length & 0xff);
  else {
    header.push((mask ? 0x80 : 0) | 127);
    const length = BigInt(body.length);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((length >> shift) & 0xffn));
  }
  if (!mask) return Buffer.concat([Buffer.from(header), body]);
  const key = Buffer.from([(maskSeed >>> 24) & 0xff, (maskSeed >>> 16) & 0xff, (maskSeed >>> 8) & 0xff, maskSeed & 0xff]);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index]! ^ key[index % 4]!;
  return Buffer.concat([Buffer.from(header), key, masked]);
}

function encodeCloseFrame(code: number, reason: string | undefined, mask: boolean, maskSeed: number): Buffer {
  const reasonBytes = normalizeCloseReason(reason);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  const body = Buffer.from(payload);
  const header: number[] = [0x88, body.length];
  if (mask) header[1] = (header[1] ?? 0) | 0x80;
  if (!mask) return Buffer.concat([Buffer.from(header), body]);
  const key = Buffer.from([(maskSeed >>> 24) & 0xff, (maskSeed >>> 16) & 0xff, (maskSeed >>> 8) & 0xff, maskSeed & 0xff]);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index]! ^ key[index % 4]!;
  return Buffer.concat([Buffer.from(header), key, masked]);
}

class WebSocketFrameParser {
  private buffer = Buffer.alloc(0);

  push(data: Buffer): ParsedFrameBatch {
    if (data.length > 0) this.buffer = Buffer.concat([this.buffer, data]);
    const frames: ParsedWebSocketFrame[] = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      const shortLength = second & 0x7f;
      let headerLength = 2;
      let length = shortLength;
      if (shortLength === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (shortLength === 127) {
        if (this.buffer.length < 10) break;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME_BYTES)) {
          const malformed = this.buffer;
          this.buffer = Buffer.alloc(0);
          return { frames, malformed };
        }
        length = Number(longLength);
        headerLength = 10;
      }
      const fullHeaderLength = headerLength + (masked ? 4 : 0);
      if (fullHeaderLength + length > MAX_FRAME_BYTES + 14) {
        const malformed = this.buffer;
        this.buffer = Buffer.alloc(0);
        return { frames, malformed };
      }
      if (this.buffer.length < fullHeaderLength + length) break;
      const raw = this.buffer.subarray(0, fullHeaderLength + length);
      this.buffer = this.buffer.subarray(fullHeaderLength + length);
      let payload = raw.subarray(fullHeaderLength);
      if (masked) {
        const key = raw.subarray(headerLength, fullHeaderLength);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ key[index % 4]!;
      } else payload = Buffer.from(payload);
      const invalidOpcode = opcode > 0xa || (opcode >= 0x8 && (!fin || length > 125));
      if (invalidOpcode) return { frames, malformed: raw };
      frames.push({ raw: Buffer.from(raw), payload, opcode, fin });
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      const malformed = this.buffer;
      this.buffer = Buffer.alloc(0);
      return { frames, malformed };
    }
    return { frames };
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

export class NetworkFaultController {
  private readonly target: URL;
  private readonly bindHost: string;
  private readonly eventLogLimit: number;
  private readonly rules = new Map<string, InternalRule>();
  private readonly connections = new Set<ProxyConnection>();
  private readonly sockets = new Set<net.Socket>();
  private readonly requests = new Set<http.ClientRequest>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(event: NetworkFaultEvent) => void>();
  private readonly generationByTerminal = new Map<string, number>();
  private readonly eventLog: NetworkFaultEvent[] = [];
  private server?: http.Server;
  private startPromise?: Promise<NetworkFaultAddress>;
  private address?: NetworkFaultAddress;
  private nextConnectionId = 1;
  private nextRuleId = 1;
  private maskSeed = 0x13572468;
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(options: NetworkFaultControllerOptions) {
    this.target = new URL(options.targetOrigin);
    if (this.target.protocol === "ws:") this.target.protocol = "http:";
    if (this.target.protocol === "wss:") this.target.protocol = "https:";
    if (this.target.protocol !== "http:" && this.target.protocol !== "https:") throw new Error("targetOrigin must use http, https, ws, or wss");
    this.bindHost = options.host ?? "127.0.0.1";
    this.eventLogLimit = Math.max(32, Math.floor(options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT));
  }

  get origin(): string {
    if (!this.address) throw new Error("NetworkFaultController has not been started");
    return this.address.origin;
  }

  get events(): readonly NetworkFaultEvent[] {
    return this.eventLog.slice();
  }

  get targetOrigin(): string {
    return this.target.origin;
  }

  async start(): Promise<NetworkFaultAddress> {
    if (this.address) return this.address;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = new Promise<NetworkFaultAddress>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.forwardHttp(request, response);
      });
      this.server = server;
      server.on("connection", (socket) => this.trackSocket(socket));
      server.on("upgrade", (request, socket, head) => void this.forwardUpgrade(request, socket as net.Socket, head));
      server.once("error", (error) => {
        this.server = undefined;
        this.startPromise = undefined;
        reject(error);
      });
      server.listen(0, this.bindHost, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          this.server = undefined;
          this.startPromise = undefined;
          reject(new Error("proxy did not receive a TCP address"));
          return;
        }
        const host = address.address.includes(":") ? `[${address.address}]` : address.address;
        this.address = { origin: `http://${host}:${address.port}`, port: address.port };
        this.emit({ type: "proxy-started", at: Date.now() });
        resolve(this.address);
      });
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    const pendingStart = this.startPromise;
    if (pendingStart && !this.address) {
      try {
        await pendingStart;
      } catch {
        return;
      }
    }
    const server = this.server;
    if (!server) {
      this.rejectWaiters(new Error("NetworkFaultController stopped"));
      return;
    }
    this.stopping = true;
    this.clearTimers();
    for (const waiter of [...this.waiters]) this.removeWaiter(waiter, new Error("NetworkFaultController stopped"));
    for (const connection of [...this.connections]) {
      connection.terminated = true;
      connection.closed = true;
      this.clearConnectionTimers(connection);
      connection.browser.parser.clear();
      connection.server.parser.clear();
      connection.client.destroy();
      connection.target?.destroy();
      this.connections.delete(connection);
      this.emitConnectionEnd(connection, true);
    }
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.startPromise = undefined;
    this.address = undefined;
    this.emit({ type: "proxy-stopped", at: Date.now() });
  }

  reset(): void {
    this.rules.clear();
    for (const connection of this.connections) {
      for (const direction of ["browser-to-server", "server-to-browser"] as const) {
        const state = this.stateFor(connection, direction);
        state.paused = false;
        state.dropped = false;
        state.bytesPerSecond = undefined;
        this.pump(connection, direction);
        this.emitConnectionEvent(connection, "restored", { direction });
      }
    }
  }

  delayUpgrade(matcher?: NetworkFaultMatcher, delayMs = DEFAULT_UPGRADE_DELAY_MS): NetworkFaultDisposer {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must not be negative");
    return this.addRule({ action: "delay-upgrade", matcher, delayMs });
  }

  pause(direction: NetworkFaultDirection, matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    const canonical = canonicalDirection(direction);
    const handle = this.addRule({ action: "pause", direction: canonical, matcher });
    if (!matcherHasFrameFields(matcher)) {
      for (const connection of this.connections) if (this.matchesConnection(connection, matcher, canonical)) this.setPaused(connection, canonical, true, handle.id);
    }
    return handle;
  }

  resume(direction: NetworkFaultDirection, matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    const canonical = canonicalDirection(direction);
    for (const [id, rule] of this.rules) if (rule.action === "pause" && rule.direction === canonical && (!matcher || sameMatcher(rule.matcher, matcher))) this.rules.delete(id);
    for (const connection of this.connections) if (this.matchesConnection(connection, matcher, canonical)) this.setPaused(connection, canonical, false);
    return this.noopHandle("resume");
  }

  throttle(direction: NetworkFaultDirection, bytesPerSecond: number, matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw new Error("bytesPerSecond must be greater than zero");
    const canonical = canonicalDirection(direction);
    const handle = this.addRule({ action: "throttle", direction: canonical, bytesPerSecond, matcher });
    if (!matcherHasFrameFields(matcher)) for (const connection of this.connections) if (this.matchesConnection(connection, matcher, canonical)) this.setThrottle(connection, canonical, bytesPerSecond, handle.id);
    return handle;
  }

  close(options: NetworkFaultCloseOptions): NetworkFaultDisposer {
    if (!closeCodeIsValid(options.code)) throw new Error(`invalid WebSocket close code: ${options.code}`);
    const handle = this.addRule({ action: "close", direction: options.direction ? canonicalDirection(options.direction) : undefined, matcher: options.matcher, code: options.code, reason: options.reason, when: options.when ?? "after" });
    if (!matcherHasFrameFields(options.matcher)) for (const connection of this.connections) {
      if (this.matchesConnection(connection, options.matcher, handleDirection(options.direction))) {
        this.performGracefulClose(connection, options.code, options.reason, options.direction, handle.id);
        connection.firedRules.add(handle.id);
      }
    }
    return handle;
  }

  terminate(matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    const handle = this.addRule({ action: "terminate", matcher });
    if (!matcherHasFrameFields(matcher)) for (const connection of this.connections) if (this.matchesConnection(connection, matcher)) {
      connection.firedRules.add(handle.id);
      this.performTerminate(connection, handle.id);
    }
    return handle;
  }

  drop(matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    const handle = this.addRule({ action: "drop", matcher });
    if (!matcherHasFrameFields(matcher)) for (const connection of this.connections) if (this.matchesConnection(connection, matcher)) this.setDropped(connection, true, handle.id);
    return handle;
  }

  restore(matcher?: NetworkFaultMatcher): NetworkFaultDisposer {
    for (const [id, rule] of this.rules) if (rule.action === "drop" && (!matcher || sameMatcher(rule.matcher, matcher))) this.rules.delete(id);
    for (const connection of this.connections) if (this.matchesConnection(connection, matcher)) {
      this.setDropped(connection, false);
    }
    return this.noopHandle("restore");
  }

  inject(options: NetworkFaultInjectOptions): NetworkFaultDisposer {
    const direction = canonicalDirection(options.direction);
    const handle = this.addRule({ action: "inject", direction, matcher: options.matcher, data: asBuffer(options.data), binary: options.binary ?? typeof options.data !== "string", raw: options.raw, when: options.when ?? "after" });
    if (!matcherHasFrameFields(options.matcher)) for (const connection of this.connections) if (this.matchesConnection(connection, options.matcher, direction)) {
      connection.firedRules.add(handle.id);
      const rule = this.rules.get(handle.id);
      if (rule) this.injectNow(connection, rule, direction, handle.id);
    }
    return handle;
  }

  injectMalformedFrame(options: NetworkFaultMalformedFrameOptions): NetworkFaultDisposer {
    const direction = canonicalDirection(options.direction);
    const handle = this.addRule({ action: "inject", direction, matcher: options.matcher, data: Buffer.from(options.data), raw: true, malformed: true, when: options.when ?? "after" });
    if (!matcherHasFrameFields(options.matcher)) for (const connection of this.connections) if (this.matchesConnection(connection, options.matcher, direction)) {
      connection.firedRules.add(handle.id);
      const rule = this.rules.get(handle.id);
      if (rule) this.injectNow(connection, rule, direction, handle.id);
    }
    return handle;
  }

  injectMalformed(options: NetworkFaultMalformedFrameOptions): NetworkFaultDisposer {
    return this.injectMalformedFrame(options);
  }

  waitFor(predicate: NetworkFaultEventPredicate, options: NetworkFaultWaitOptions = {}): Promise<NetworkFaultEvent> {
    const test = typeof predicate === "string" ? (event: NetworkFaultEvent) => event.type === predicate : predicate;
    for (const event of this.eventLog) if (test(event)) return Promise.resolve(event);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
    return new Promise<NetworkFaultEvent>((resolve, reject) => {
      const waiter: Waiter = { predicate: test, resolve, reject, signal: options.signal };
      if (options.timeoutMs !== undefined) {
        const timeout = Math.max(0, options.timeoutMs);
        waiter.timer = this.trackTimer(setTimeout(() => this.removeWaiter(waiter, new Error(`timed out waiting for network event after ${timeout}ms`)), timeout));
      }
      if (options.signal) {
        const abort = () => this.removeWaiter(waiter, abortError(options.signal?.reason));
        waiter.abortListener = abort;
        options.signal.addEventListener("abort", abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  onEvent(listener: (event: NetworkFaultEvent) => void): NetworkFaultDisposer {
    this.listeners.add(listener);
    return this.createHandle(`listener-${this.nextRuleId++}`, () => this.listeners.delete(listener));
  }

  on(listener: (event: NetworkFaultEvent) => void): NetworkFaultDisposer {
    return this.onEvent(listener);
  }

  private async forwardHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (this.stopping) {
      response.destroy();
      return;
    }
    const requestPath = appendPath(this.target.pathname, request.url ?? "/");
    this.emit({ type: "http-request", at: Date.now(), path: pathName(request.url ?? "/") });
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers[name] = value;
    headers.host = this.target.host;
    const options: http.RequestOptions & { rejectUnauthorized?: boolean } = { protocol: this.target.protocol, hostname: this.target.hostname, port: this.target.port || (this.target.protocol === "https:" ? 443 : 80), method: request.method, path: requestPath, headers, rejectUnauthorized: false };
    const onResponse = (upstreamResponse: http.IncomingMessage) => {
      this.emit({ type: "http-response", at: Date.now(), path: pathName(request.url ?? "/"), statusCode: upstreamResponse.statusCode });
      if (!response.headersSent) response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    };
    const upstream = this.target.protocol === "https:" ? https.request(options as https.RequestOptions, onResponse) : http.request(options, onResponse);
    this.requests.add(upstream);
    upstream.once("error", () => {
      this.requests.delete(upstream);
      if (!response.headersSent) response.writeHead(502);
      response.destroy();
    });
    upstream.once("close", () => this.requests.delete(upstream));
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  private async forwardUpgrade(request: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    if (this.stopping) {
      client.destroy();
      return;
    }
    const requestUrl = request.url ?? "/";
    const path = pathName(requestUrl);
    const terminalId = terminalIdFromPath(path);
    const terminalKey = terminalId ?? path;
    const explicitGeneration = generationFromUrl(requestUrl);
    const generation = explicitGeneration ?? (this.generationByTerminal.get(terminalKey) ?? 0) + 1;
    this.generationByTerminal.set(terminalKey, generation);
    const connection: ProxyConnection = { id: this.nextConnectionId++, path, requestUrl, ...(terminalId === undefined ? {} : { terminalId }), generation, client, browser: this.newDirectionState(), server: this.newDirectionState(), timers: new Set(), firedRules: new Set(), activatedRules: new Set(), occurrences: new Map(), closeCodes: {}, handshakeOpen: false, handshakeResponseSeen: false, handshakeBuffer: Buffer.alloc(0), pendingBrowser: [], pendingServer: [], closed: false, closing: false, terminated: false };
    this.connections.add(connection);
    this.trackSocket(client);
    client.on("data", (data) => this.handleBrowserData(connection, Buffer.from(data)));
    client.once("error", () => this.handleSocketError(connection, "browser"));
    client.once("close", () => this.handleSocketClosed(connection, "browser"));
    this.emitConnectionEvent(connection, "upgrade-request");
    const targetSocket = this.connectTarget();
    connection.target = targetSocket;
    this.trackSocket(targetSocket);
    targetSocket.once("error", () => this.handleSocketError(connection, "server"));
    targetSocket.once("close", () => this.handleSocketClosed(connection, "server"));
    targetSocket.on("data", (data) => this.handleServerData(connection, Buffer.from(data)));
    const readyEvent = this.target.protocol === "https:" ? "secureConnect" : "connect";
    targetSocket.once(readyEvent, () => {
      if (connection.closed) return;
      targetSocket.write(this.buildUpgradeRequest(request, requestPath(this.target.pathname, requestUrl)));
      if (head.length > 0) connection.pendingBrowser.push(Buffer.from(head));
      connection.handshakeTimer = this.connectionTimer(connection, () => {
        connection.client.destroy();
        connection.target?.destroy();
        this.finishConnection(connection, true);
      }, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    });
  }

  private connectTarget(): net.Socket {
    const port = Number(this.target.port || (this.target.protocol === "https:" ? 443 : 80));
    if (this.target.protocol === "https:") return tls.connect({ host: this.target.hostname, port, servername: this.target.hostname, rejectUnauthorized: false });
    return net.connect({ host: this.target.hostname, port });
  }

  private buildUpgradeRequest(request: http.IncomingMessage, upgradePath: string): Buffer {
    const lines = [`${request.method ?? "GET"} ${upgradePath} HTTP/1.1`];
    let hasHost = false;
    let hasConnection = false;
    let hasUpgrade = false;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (!name || value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === "host") {
        if (!hasHost) lines.push(`Host: ${this.target.host}`);
        hasHost = true;
      } else if (lower === "connection") {
        if (!hasConnection) lines.push("Connection: Upgrade");
        hasConnection = true;
      } else if (lower === "upgrade") {
        if (!hasUpgrade) lines.push("Upgrade: websocket");
        hasUpgrade = true;
      } else if (lower !== "sec-websocket-extensions") lines.push(`${name}: ${value}`);
    }
    if (!hasHost) lines.push(`Host: ${this.target.host}`);
    if (!hasConnection) lines.push("Connection: Upgrade");
    if (!hasUpgrade) lines.push("Upgrade: websocket");
    return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
  }

  private handleBrowserData(connection: ProxyConnection, data: Buffer): void {
    if (connection.closed) return;
    if (!connection.handshakeOpen) {
      if (data.length > 0) connection.pendingBrowser.push(Buffer.from(data));
      return;
    }
    this.handleFrameData(connection, "browser-to-server", data);
  }

  private handleServerData(connection: ProxyConnection, data: Buffer): void {
    if (connection.closed) return;
    if (!connection.handshakeResponseSeen) {
      connection.handshakeBuffer = Buffer.concat([connection.handshakeBuffer, data]);
      const headerEnd = findHeaderEnd(connection.handshakeBuffer);
      if (headerEnd < 0) return;
      const responseEnd = headerEnd + 4;
      const header = connection.handshakeBuffer.subarray(0, responseEnd);
      const tail = connection.handshakeBuffer.subarray(responseEnd);
      connection.handshakeBuffer = Buffer.alloc(0);
      connection.handshakeResponseSeen = true;
      const statusLine = header.toString("latin1").split("\r\n", 1)[0] ?? "";
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (status !== 101) {
        connection.client.write(header);
        if (tail.length > 0) connection.client.write(tail);
        connection.client.end();
        connection.target?.end();
        this.finishConnection(connection, false);
        return;
      }
      const delay = this.upgradeDelay(connection);
      if (delay > 0) {
        this.emitConnectionEvent(connection, "upgrade-delay", { bytes: delay });
        connection.pendingServer.push(Buffer.from(header));
        if (tail.length > 0) connection.pendingServer.push(Buffer.from(tail));
        connection.handshakeTimer = this.connectionTimer(connection, () => this.openHandshake(connection), delay);
        return;
      }
      this.openHandshake(connection, header, tail);
      return;
    }
    if (!connection.handshakeOpen) {
      connection.pendingServer.push(data);
      return;
    }
    this.handleFrameData(connection, "server-to-browser", data);
  }

  private openHandshake(connection: ProxyConnection, header?: Buffer, tail?: Buffer): void {
    if (connection.closed || connection.handshakeOpen) return;
    this.clearConnectionTimer(connection, connection.handshakeTimer);
    connection.handshakeTimer = undefined;
    connection.handshakeOpen = true;
    const response = header ?? connection.pendingServer.shift();
    if (response && connection.client.writable) connection.client.write(response);
    this.emitConnectionEvent(connection, "upgrade-open");
    this.emitConnectionEvent(connection, "connection-open");
    this.applyRulesToConnection(connection);
    const serverData = tail ?? Buffer.concat(connection.pendingServer.splice(0));
    const browserData = Buffer.concat(connection.pendingBrowser.splice(0));
    if (browserData.length > 0) this.handleFrameData(connection, "browser-to-server", browserData);
    if (serverData.length > 0) this.handleFrameData(connection, "server-to-browser", serverData);
  }
  private applyRulesToConnection(connection: ProxyConnection): void {
    for (const rule of this.rules.values()) {
      if (connection.closed || connection.firedRules.has(rule.id) || matcherHasFrameFields(rule.matcher)) continue;
      if (!this.matchesConnection(connection, rule.matcher, rule.direction)) continue;
      if (rule.action === "pause" && rule.direction) {
        this.setPaused(connection, rule.direction, true, rule.id);
      } else if (rule.action === "throttle" && rule.direction && rule.bytesPerSecond !== undefined) {
        this.setThrottle(connection, rule.direction, rule.bytesPerSecond, rule.id);
      } else if (rule.action === "drop") {
        this.setDropped(connection, true, rule.id);
      } else if (rule.action === "inject" && rule.direction) {
        connection.firedRules.add(rule.id);
        this.injectNow(connection, rule, rule.direction, rule.id);
      } else if (rule.action === "close") {
        connection.firedRules.add(rule.id);
        this.performGracefulClose(connection, rule.code ?? 1000, rule.reason, rule.direction, rule.id);
      } else if (rule.action === "terminate") {
        connection.firedRules.add(rule.id);
        this.performTerminate(connection, rule.id);
      }
    }
  }


  private handleFrameData(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", data: Buffer): void {
    const state = this.stateFor(connection, direction);
    const batch = state.parser.push(data);
    for (const frame of batch.frames) this.handleFrame(connection, direction, frame);
    if (batch.malformed && batch.malformed.length > 0) {
      this.emitConnectionEvent(connection, "malformed-frame", { direction, bytes: batch.malformed.length });
      this.enqueueRaw(connection, direction, batch.malformed);
    }
  }

  private handleFrame(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", frame: ParsedWebSocketFrame): void {
    const metadata = this.describeFrame(connection, frame);
    const { frameCode: _frameCode, sequenceBigInt: _sequenceBigInt, ...publicFrame } = metadata;
    this.emit({ type: "frame", at: Date.now(), connectionId: connection.id, path: connection.path, terminalId: connection.terminalId, generation: connection.generation, direction, bytes: frame.raw.length, frame: Object.freeze(publicFrame) });
    if (metadata.frameCode !== undefined) connection.closeCodes[direction === "browser-to-server" ? "browser" : "server"] = metadata.frameCode;
    const matchingRules = [...this.rules.values()].filter((rule) => this.matchesFrame(connection, direction, metadata, rule.matcher, rule.direction));
    for (const rule of matchingRules) {
      if (connection.firedRules.has(rule.id)) continue;
      if (rule.action === "pause") {
        connection.activatedRules.add(rule.id);
        this.setPaused(connection, direction, true, rule.id);
      } else if (rule.action === "throttle" && rule.bytesPerSecond !== undefined) {
        connection.activatedRules.add(rule.id);
        this.setThrottle(connection, direction, rule.bytesPerSecond, rule.id);
      } else if (rule.action === "drop" && !matcherHasFrameFields(rule.matcher)) {
        connection.activatedRules.add(rule.id);
        this.setDropped(connection, true, rule.id);
      }
    }
    let dropFrame = false;
    let closeBefore: InternalRule | undefined;
    let closeAfter: InternalRule | undefined;
    let terminateBefore = false;
    let terminateAfter = false;
    const injectionsBefore: InternalRule[] = [];
    const injectionsAfter: InternalRule[] = [];
    for (const rule of matchingRules) {
      if (connection.firedRules.has(rule.id)) continue;
      if (rule.action === "inject") {
        (rule.when === "before" ? injectionsBefore : injectionsAfter).push(rule);
        connection.firedRules.add(rule.id);
      } else if (rule.action === "close") {
        if (rule.when === "before") closeBefore = rule;
        else closeAfter = rule;
        connection.firedRules.add(rule.id);
      } else if (rule.action === "terminate") {
        if (rule.when === "before") terminateBefore = true;
        else terminateAfter = true;
        connection.firedRules.add(rule.id);
      } else if (rule.action === "drop") {
        dropFrame = true;
        connection.firedRules.add(rule.id);
        if (matcherHasFrameFields(rule.matcher)) this.emitConnectionEvent(connection, "dropped", { direction, bytes: frame.raw.length, ruleId: rule.id });
      }
    }
    for (const rule of injectionsBefore) this.injectNow(connection, rule, direction, rule.id);
    if (terminateBefore) {
      this.performTerminate(connection, matchingRules.find((rule) => rule.action === "terminate")?.id);
      return;
    }
    if (closeBefore) {
      this.performGracefulClose(connection, closeBefore.code ?? 1000, closeBefore.reason, closeBefore.direction, closeBefore.id);
      return;
    }
    if (!dropFrame) this.enqueueRaw(connection, direction, frame.raw);
    for (const rule of injectionsAfter) this.injectNow(connection, rule, direction, rule.id);
    if (terminateAfter) this.performTerminate(connection, matchingRules.find((rule) => rule.action === "terminate")?.id);
    else if (closeAfter) this.performGracefulClose(connection, closeAfter.code ?? 1000, closeAfter.reason, closeAfter.direction, closeAfter.id);
  }

  private describeFrame(connection: ProxyConnection, frame: ParsedWebSocketFrame): InternalFrameMetadata {
    let jsonType: string | undefined;
    let binaryKind: number | undefined;
    let sequence: number | undefined;
    let sequenceUnsafe = false;
    let sequenceBigInt: bigint | undefined;
    if (frame.opcode === 1 || frame.opcode === 0) {
      try {
        const value: unknown = JSON.parse(frame.payload.toString("utf8"));
        if (typeof value === "object" && value !== null && "type" in value) {
          const typedValue = value as { type?: unknown; sequence?: unknown };
          if (typeof typedValue.type === "string") jsonType = typedValue.type;
          if (
            typeof typedValue.sequence === "number"
            && Number.isFinite(typedValue.sequence)
            && Number.isInteger(typedValue.sequence)
            && typedValue.sequence >= 0
          ) {
            if (Number.isSafeInteger(typedValue.sequence)) {
              sequence = typedValue.sequence;
              sequenceBigInt = BigInt(typedValue.sequence);
            } else {
              sequenceUnsafe = true;
            }
          }
        }
      } catch {
        // Invalid JSON is forwarded as-is for explicit protocol-failure scenarios.
      }
    } else if (frame.opcode === 2 && frame.payload.length > 0) {
      binaryKind = frame.payload[0];
      if (frame.payload.length >= 9) {
        sequenceBigInt = frame.payload.readBigUInt64BE(1);
        if (sequenceBigInt <= MAX_SAFE_BIGINT) sequence = Number(sequenceBigInt);
        else sequenceUnsafe = true;
      }
    }
    const key = jsonType !== undefined ? `json:${jsonType}` : binaryKind !== undefined ? `binary:${binaryKind}` : undefined;
    const occurrence = key === undefined ? 0 : (connection.occurrences.get(key) ?? 0) + 1;
    if (key !== undefined) connection.occurrences.set(key, occurrence);
    const frameCode = frame.opcode === 8 && frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
    return { opcode: frame.opcode, fin: frame.fin, bytes: frame.raw.length, ...(jsonType === undefined ? {} : { jsonType }), ...(binaryKind === undefined ? {} : { binaryKind }), ...(sequence === undefined ? {} : { sequence }), ...(sequenceUnsafe ? { sequenceUnsafe } : {}), occurrence, ...(frameCode === undefined ? {} : { frameCode }), ...(sequenceBigInt === undefined ? {} : { sequenceBigInt }) };
  }

  private injectNow(connection: ProxyConnection, rule: InternalRule, direction: "browser-to-server" | "server-to-browser", ruleId: string): void {
    if (connection.closed || !rule.data) return;
    const effectiveDirection = rule.direction ?? direction;
    const raw = rule.raw || rule.malformed ? Buffer.from(rule.data) : encodeDataFrame(rule.data, rule.binary ?? true, effectiveDirection === "browser-to-server", this.nextMaskSeed());
    this.emitConnectionEvent(connection, "injected", { direction: effectiveDirection, bytes: raw.length, ruleId });
    this.enqueueRaw(connection, effectiveDirection, raw);
  }

  private performGracefulClose(connection: ProxyConnection, code: number, reason: string | undefined, direction: NetworkFaultDirection | undefined, ruleId?: string): void {
    if (connection.closed || connection.closing) return;
    connection.closing = true;
    connection.gracefulCloseCode = code;
    const directions = direction === undefined ? (["browser-to-server", "server-to-browser"] as const) : ([canonicalDirection(direction)] as const);
    for (const currentDirection of directions) {
      const state = this.stateFor(connection, currentDirection);
      state.paused = false;
      state.dropped = false;
      const frame = encodeCloseFrame(code, reason, currentDirection === "browser-to-server", this.nextMaskSeed());
      state.queue.push(frame);
      this.pump(connection, currentDirection);
      this.emitConnectionEvent(connection, "close-sent", { direction: currentDirection, bytes: frame.length, code, ruleId });
    }
    this.connectionTimer(connection, () => {
      if (connection.closed) return;
      connection.client.end();
      connection.target?.end();
      this.finishConnection(connection, false);
    }, GRACEFUL_CLOSE_TIMEOUT_MS);
  }

  private performTerminate(connection: ProxyConnection, ruleId?: string): void {
    if (connection.closed) return;
    connection.terminated = true;
    this.emitConnectionEvent(connection, "terminated", { ruleId });
    connection.client.destroy();
    connection.target?.destroy();
    this.finishConnection(connection, true);
  }

  private setPaused(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", paused: boolean, ruleId?: string): void {
    const state = this.stateFor(connection, direction);
    if (state.paused === paused) return;
    state.paused = paused;
    this.emitConnectionEvent(connection, paused ? "paused" : "resumed", { direction, ruleId });
    if (!paused) this.pump(connection, direction);
  }

  private setDropped(connection: ProxyConnection, dropped: boolean, ruleId?: string): void {
    for (const direction of ["browser-to-server", "server-to-browser"] as const) {
      const state = this.stateFor(connection, direction);
      if (state.dropped === dropped) continue;
      state.dropped = dropped;
      this.emitConnectionEvent(connection, dropped ? "dropped" : "restored", { direction, ruleId });
      if (!dropped) this.pump(connection, direction);
    }
  }

  private setThrottle(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", bytesPerSecond: number, ruleId?: string): void {
    const state = this.stateFor(connection, direction);
    state.bytesPerSecond = bytesPerSecond;
    this.emitConnectionEvent(connection, "throttled", { direction, bytes: bytesPerSecond, ruleId });
    this.pump(connection, direction);
  }

  private enqueueRaw(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", data: Buffer): void {
    if (connection.closed || data.length === 0) return;
    const state = this.stateFor(connection, direction);
    state.queue.push(Buffer.from(data));
    this.pump(connection, direction);
  }

  private pump(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser"): void {
    const state = this.stateFor(connection, direction);
    if (connection.closed || state.paused || state.dropped || state.pumping || state.queue.length === 0) return;
    const target = direction === "browser-to-server" ? connection.target : connection.client;
    if (!target || target.destroyed || !target.writable) return;
    state.pumping = true;
    if (state.bytesPerSecond !== undefined) {
      const chunk = state.queue.shift();
      if (chunk) {
        try {
          target.write(chunk);
        } catch {
          this.handleSocketError(connection, direction === "browser-to-server" ? "server" : "browser");
        }
        const delay = Math.max(1, Math.ceil((chunk.length * 1000) / state.bytesPerSecond));
        state.timer = this.connectionTimer(connection, () => {
          state.timer = undefined;
          state.pumping = false;
          this.pump(connection, direction);
        }, delay);
        return;
      }
    }
    while (state.queue.length > 0 && !state.paused && !state.dropped && !connection.closed) {
      const chunk = state.queue.shift();
      if (!chunk) break;
      try {
        target.write(chunk);
      } catch {
        this.handleSocketError(connection, direction === "browser-to-server" ? "server" : "browser");
        break;
      }
    }
    state.pumping = false;
  }

  private stateFor(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser"): DirectionState {
    return direction === "browser-to-server" ? connection.browser : connection.server;
  }

  private upgradeDelay(connection: ProxyConnection): number {
    let delay = 0;
    for (const rule of this.rules.values()) if (rule.action === "delay-upgrade" && !matcherHasFrameFields(rule.matcher) && this.matchesConnection(connection, rule.matcher)) delay = Math.max(delay, rule.delayMs ?? DEFAULT_UPGRADE_DELAY_MS);
    return delay;
  }

  private addRule(rule: Omit<InternalRule, "id">): NetworkFaultDisposer {
    const id = `fault-${this.nextRuleId++}`;
    this.rules.set(id, { ...rule, id });
    return this.createHandle(id, () => {
      this.rules.delete(id);
      for (const connection of this.connections) {
        connection.firedRules.delete(id);
        connection.activatedRules.delete(id);
        this.recomputeConnectionRules(connection);
      }
    });
  }

  private recomputeConnectionRules(connection: ProxyConnection): void {
    for (const direction of ["browser-to-server", "server-to-browser"] as const) {
      const state = this.stateFor(connection, direction);
      state.paused = [...this.rules.values()].some((rule) => rule.action === "pause" && rule.direction === direction && !matcherHasFrameFields(rule.matcher) && this.matchesConnection(connection, rule.matcher, direction));
      state.dropped = [...this.rules.values()].some((rule) => rule.action === "drop" && !matcherHasFrameFields(rule.matcher) && this.matchesConnection(connection, rule.matcher));
      state.bytesPerSecond = [...this.rules.values()].filter((rule) => rule.action === "throttle" && rule.direction === direction && !matcherHasFrameFields(rule.matcher) && this.matchesConnection(connection, rule.matcher, direction)).at(-1)?.bytesPerSecond;
      this.pump(connection, direction);
    }
  }

  private matchesConnection(connection: ProxyConnection, matcher?: NetworkFaultMatcher, direction?: "browser-to-server" | "server-to-browser"): boolean {
    if (!matcher) return true;
    const wantedDirection = matcher.direction ? canonicalDirection(matcher.direction) : direction;
    if (wantedDirection && direction && wantedDirection !== direction) return false;
    if (matcher.path !== undefined && !globMatches(connection.path, matcher.path)) return false;
    if (matcher.url !== undefined && !globMatches(connection.requestUrl, matcher.url)) return false;
    if (matcher.terminalUrl !== undefined && !globMatches(connection.requestUrl, matcher.terminalUrl)) return false;
    if (matcher.terminalId !== undefined && matcher.terminalId !== connection.terminalId) return false;
    if (matcher.generation !== undefined && matcher.generation !== connection.generation) return false;
    return true;
  }

  private matchesFrame(connection: ProxyConnection, direction: "browser-to-server" | "server-to-browser", frame: InternalFrameMetadata, matcher: NetworkFaultMatcher | undefined, ruleDirection?: "browser-to-server" | "server-to-browser"): boolean {
    if (!this.matchesConnection(connection, matcher, direction)) return false;
    const wantedDirection = ruleDirection ?? matcher?.direction;
    if (wantedDirection && canonicalDirection(wantedDirection) !== direction) return false;
    if (!matcher) return true;
    const jsonType = matcher.jsonType ?? matcher.controlType;
    if (jsonType !== undefined && frame.jsonType !== jsonType) return false;
    const binaryKind = matcher.binaryKind ?? matcher.kind;
    if (binaryKind !== undefined && frame.binaryKind !== binaryKind) return false;
    if (matcher.sequence !== undefined) {
      if (frame.sequenceBigInt === undefined) return false;
      if (typeof matcher.sequence === "bigint" ? matcher.sequence !== frame.sequenceBigInt : BigInt(matcher.sequence) !== frame.sequenceBigInt) return false;
    }
    if (matcher.occurrence !== undefined && frame.occurrence !== matcher.occurrence) return false;
    return true;
  }

  private newDirectionState(): DirectionState {
    return { parser: new WebSocketFrameParser(), queue: [], paused: false, dropped: false, pumping: false };
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private handleSocketError(connection: ProxyConnection, side: "browser" | "server"): void {
    if (connection.closed) return;
    this.emitConnectionEvent(connection, "socket-error", { direction: side === "browser" ? "browser-to-server" : "server-to-browser" });
    if (side === "browser") connection.target?.destroy();
    else connection.client.destroy();
  }

  private handleSocketClosed(connection: ProxyConnection, side: "browser" | "server"): void {
    if (connection.closed) return;
    if (side === "browser") connection.target?.destroy();
    else connection.client.destroy();
    const hasCloseFrame = Object.keys(connection.closeCodes).length > 0 || connection.closing;
    this.finishConnection(connection, !hasCloseFrame);
  }

  private finishConnection(connection: ProxyConnection, abrupt: boolean): void {
    if (connection.closed && !this.connections.has(connection)) return;
    connection.closed = true;
    this.clearConnectionTimers(connection);
    this.connections.delete(connection);
    connection.target?.destroy();
    if (abrupt && !connection.client.destroyed) connection.client.destroy();
    this.emitConnectionEnd(connection, abrupt);
  }

  private emitConnectionEnd(connection: ProxyConnection, abrupt: boolean): void {
    this.emit({ type: abrupt || connection.terminated ? "connection-terminated" : "connection-closed", at: Date.now(), connectionId: connection.id, path: connection.path, terminalId: connection.terminalId, generation: connection.generation, code: connection.gracefulCloseCode ?? connection.closeCodes.browser ?? connection.closeCodes.server ?? (abrupt ? 1006 : undefined), abrupt: abrupt || connection.terminated });
  }

  private emitConnectionEvent(connection: ProxyConnection, type: NetworkFaultEventType, extra: Partial<NetworkFaultEvent> = {}): void {
    this.emit({ type, at: Date.now(), connectionId: connection.id, path: connection.path, terminalId: connection.terminalId, generation: connection.generation, ...extra });
  }

  private emit(event: NetworkFaultEvent): void {
    const frozen = Object.freeze(event);
    this.eventLog.push(frozen);
    while (this.eventLog.length > this.eventLogLimit) this.eventLog.shift();
    for (const listener of this.listeners) {
      try {
        listener(frozen);
      } catch {
        // Observability must never interfere with traffic.
      }
    }
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try {
        matched = waiter.predicate(frozen);
      } catch (error) {
        this.removeWaiter(waiter, error);
        continue;
      }
      if (matched) this.removeWaiter(waiter, undefined, frozen);
    }
  }

  private createHandle(id: string, dispose: () => void): NetworkFaultDisposer {
    let disposed = false;
    const handle = (() => {
      if (disposed) return;
      disposed = true;
      dispose();
    }) as NetworkFaultDisposer;
    Object.defineProperty(handle, "id", { enumerable: true, value: id });
    handle.dispose = handle;
    return handle;
  }

  private noopHandle(prefix: string): NetworkFaultDisposer {
    return this.createHandle(`${prefix}-${this.nextRuleId++}`, () => undefined);
  }

  private nextMaskSeed(): number {
    this.maskSeed = (this.maskSeed + 0x9e3779b9) >>> 0;
    return this.maskSeed;
  }

  private trackTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.timers.add(timer);
    return timer;
  }

  private connectionTimer(connection: ProxyConnection, callback: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      connection.timers.delete(timer);
      this.timers.delete(timer);
      if (!connection.closed) callback();
    }, Math.max(0, delayMs));
    connection.timers.add(timer);
    this.timers.add(timer);
    return timer;
  }

  private clearConnectionTimer(connection: ProxyConnection, timer: NodeJS.Timeout | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    connection.timers.delete(timer);
    this.timers.delete(timer);
  }

  private clearConnectionTimers(connection: ProxyConnection): void {
    for (const timer of connection.timers) clearTimeout(timer);
    for (const timer of connection.timers) this.timers.delete(timer);
    connection.timers.clear();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const connection of this.connections) {
      for (const timer of connection.timers) clearTimeout(timer);
      connection.timers.clear();
    }
  }

  private removeWaiter(waiter: Waiter, error?: unknown, event?: NetworkFaultEvent): void {
    if (!this.waiters.delete(waiter)) return;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      this.timers.delete(waiter.timer);
    }
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
    if (event) waiter.resolve(event);
    else if (error !== undefined) waiter.reject(error);
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of [...this.waiters]) this.removeWaiter(waiter, error);
  }
}

function sameMatcher(left: NetworkFaultMatcher | undefined, right: NetworkFaultMatcher | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys: (keyof NetworkFaultMatcher)[] = ["path", "url", "terminalUrl", "terminalId", "generation", "direction", "jsonType", "controlType", "kind", "binaryKind", "sequence", "occurrence"];
  return keys.every((key) => left[key] === right[key]);
}

function handleDirection(direction: NetworkFaultDirection | undefined): "browser-to-server" | "server-to-browser" | undefined {
  return direction === undefined ? undefined : canonicalDirection(direction);
}

function requestPath(base: string, path: string): string {
  return appendPath(base, path);
}

function abortError(reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(reason === undefined ? "operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

export default NetworkFaultController;
