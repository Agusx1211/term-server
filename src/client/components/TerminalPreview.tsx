import { TerminalSquare } from "lucide-preact";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ClientTerminalMessage,
  ServerTerminalMessage,
  TerminalInfo,
} from "../../shared/types";
import {
  terminalPreviewFontSize,
  type TerminalPreviewMode,
} from "../lib/terminal-preview";
import { PanoptesUnicode17Addon } from "../lib/terminal-unicode";
import { tuiCompatibilityOptions } from "../lib/terminal-compatibility";
import { loadTerminalNerdFont, TERMINAL_FONT_FAMILY } from "../lib/terminal-font";
import { addTerminalStreamProtocol, closeTerminalSocket } from "../lib/terminal-socket";
import {
  TERMINAL_FRAME_OUTPUT,
  TERMINAL_FRAME_SNAPSHOT,
  TerminalRenderBacklog,
  TerminalStreamState,
  decodeTerminalFrame,
  type TerminalBacklogKind,
  type TerminalFrame,
} from "../lib/terminal-stream";
import {
  registerE2ETerminal,
  type E2ETerminalDiagnosticsHandle,
  type E2EViewport,
} from "../lib/e2e-diagnostics";
import {
  mixedTerminalBackground,
  terminalTheme,
  type ThemeName,
} from "../lib/terminal-theme";

interface TerminalPreviewProps {
  terminal: TerminalInfo;
  theme: ThemeName;
  mode: TerminalPreviewMode;
  position: { left: number; top: number };
  animationDuration: number;
}

type PreviewConnection = "connecting" | "connected" | "unavailable";

export function TerminalPreview({
  terminal,
  theme,
  mode,
  position,
  animationDuration,
}: TerminalPreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const paneId = `preview-${terminal.id}`;
  const diagnostics = useRef<E2ETerminalDiagnosticsHandle>();
  if (!diagnostics.current) {
    diagnostics.current = registerE2ETerminal({
      terminalId: terminal.id,
      paneId,
      kind: "preview",
    });
  }
  const xterm = useRef<XTerm>();
  const [connection, setConnection] = useState<PreviewConnection>("connecting");
  const [message, setMessage] = useState("Connecting live preview…");

  useEffect(() => {
    const diagnosticsHandle = diagnostics.current;
    diagnosticsHandle?.update({ mounted: true, visible: true, cached: false, active: true });
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let reportedUnavailable = false;
    let cols = 80;
    let rows = 24;
    let lastServerMessage = Date.now();
    const term = new XTerm({
      allowProposedApi: true,
      cols,
      rows,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: mode === "large" ? 15 : 11,
      letterSpacing: 0,
      lineHeight: 1.15,
      minimumContrastRatio: 1,
      scrollback: 0,
      theme: terminalTheme(theme, terminal.color),
      ...tuiCompatibilityOptions(),
    });
    xterm.current = term;
    term.loadAddon(new PanoptesUnicode17Addon());
    term.open(host);
    diagnosticsHandle?.updateXterm(term);
    const renderDisposable = term.onRender(() => {
      diagnosticsHandle?.rendererRendered();
    });
    void loadTerminalNerdFont().then(() => {
      if (disposed) return;
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    });

    const fitExistingGrid = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      const fontSize = terminalPreviewFontSize(
        cols,
        rows,
        host.clientWidth,
        host.clientHeight,
        mode,
      );
      const viewport = {
        cols,
        rows,
        pixelWidth: host.clientWidth,
        pixelHeight: host.clientHeight,
      };
      diagnosticsHandle?.update({
        proposedViewport: { ...viewport, source: "proposed" } satisfies E2EViewport,
        desiredViewport: { ...viewport, source: "desired" } satisfies E2EViewport,
      });
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    };
    const resizeObserver = new ResizeObserver(fitExistingGrid);
    resizeObserver.observe(host);
    fitExistingGrid();

    const stream = new TerminalStreamState();
    const backlog = new TerminalRenderBacklog();
    let abandoned = false;
    let messageQueue = Promise.resolve();
    // Resolves once xterm has parsed every frame handed to it so far. Frames are
    // written as they arrive rather than one per settled parse; see TerminalPane.
    let pendingWrites = Promise.resolve();
    let pendingWriteCount = 0;
    let pendingWriteBytes = 0;
    const updateStreamDiagnostics = () => {
      diagnosticsHandle?.parserState(pendingWriteCount, pendingWriteBytes);
      diagnosticsHandle?.renderBacklog({
        bytes: backlog.pendingBytes,
        frames: backlog.pendingFrames,
        oldestAgeMs: backlog.oldestAgeMs,
      });
      diagnosticsHandle?.streamState({
        receivedSequence: stream.received,
        committedSequence: stream.committed,
        syncMode: stream.mode,
        syncTarget: stream.target,
      });
    };
    const writeTerminal = (data: Uint8Array, commit?: number) => new Promise<void>(
      (resolve, reject) => {
        pendingWriteCount += 1;
        pendingWriteBytes += data.byteLength;
        updateStreamDiagnostics();
        try {
          term.write(data, () => {
            pendingWriteCount -= 1;
            pendingWriteBytes = Math.max(0, pendingWriteBytes - data.byteLength);
            try {
              if (commit !== undefined) stream.commit(commit);
              diagnosticsHandle?.updateXterm(term);
              updateStreamDiagnostics();
              resolve();
            } catch (error) {
              updateStreamDiagnostics();
              reject(error);
            }
          });
        } catch (error) {
          pendingWriteCount -= 1;
          pendingWriteBytes = Math.max(0, pendingWriteBytes - data.byteLength);
          updateStreamDiagnostics();
          reject(error);
        }
      },
    );

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = addTerminalStreamProtocol(
      new URL(`${protocol}//${location.host}/api/terminals/${terminal.id}/socket`),
    );
    url.searchParams.set("observer", "true");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    diagnosticsHandle?.socketCreated(socket, url.toString());
    const showUnavailable = (value: string) => {
      reportedUnavailable = true;
      setConnection("unavailable");
      setMessage(value);
    };
    const onStreamFailure = (error: unknown) => {
      if (disposed || abandoned) return;
      abandoned = true;
      showUnavailable(error instanceof Error ? error.message : "Preview unavailable");
      closeTerminalSocket(socket, "protocol-error");
    };
    socket.addEventListener("open", () => {
      if (disposed) return;
      diagnosticsHandle?.socketOpened(socket);
    });

    socket.addEventListener("message", (event) => {
      if (disposed || abandoned) return;
      diagnosticsHandle?.socketMessage(socket, event.data);
      lastServerMessage = Date.now();
      let eagerFrame: TerminalFrame | undefined;
      let queuedBytes = 0;
      if (event.data instanceof ArrayBuffer) {
        try {
          eagerFrame = decodeTerminalFrame(event.data);
        } catch (error) {
          abandoned = true;
          showUnavailable(error instanceof Error ? error.message : "Preview unavailable");
          closeTerminalSocket(socket, "protocol-error");
          return;
        }
        if (eagerFrame.kind === TERMINAL_FRAME_OUTPUT || eagerFrame.kind === TERMINAL_FRAME_SNAPSHOT) {
          const backlogKind: TerminalBacklogKind = eagerFrame.kind === TERMINAL_FRAME_SNAPSHOT ? "snapshot" : "output";
          queuedBytes = eagerFrame.data.byteLength;
          if (backlog.enqueue(queuedBytes, Date.now(), backlogKind)) {
            abandoned = true;
            showUnavailable("Preview renderer fell behind");
            closeTerminalSocket(socket, "backlog");
            return;
          }
          updateStreamDiagnostics();
        }
      }
      messageQueue = messageQueue.then(async () => {
        try {
          if (disposed || abandoned) return;
          const binary = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          if (binary instanceof ArrayBuffer) {
            const frame = eagerFrame ?? decodeTerminalFrame(binary);
            const commit = stream.accept(frame);
            diagnosticsHandle?.outputReceived(
              stream.received ?? frame.sequence,
              frame.data.byteLength,
            );
            updateStreamDiagnostics();
            const settled = queuedBytes;
            queuedBytes = 0;
            pendingWrites = writeTerminal(frame.data, commit)
              .catch(onStreamFailure)
              .finally(() => backlog.settle(settled));
            return;
          }
          // Resets and resizes must land after the writes ahead of them.
          await pendingWrites;
          if (disposed || abandoned) return;
          const control = JSON.parse(String(event.data)) as ServerTerminalMessage;
          if (control.type === "size") {
            cols = control.cols;
            rows = control.rows;
            term.resize(cols, rows);
            fitExistingGrid();
            diagnosticsHandle?.update({
              serverViewport: {
                cols,
                rows,
                pixelWidth: host.clientWidth,
                pixelHeight: host.clientHeight,
                source: "server",
              } satisfies E2EViewport,
            });
            diagnosticsHandle?.updateXterm(term);
            updateStreamDiagnostics();
          }
          if (control.type === "sync") {
            if (stream.begin(control.mode, control.sequence)) term.reset();
            diagnosticsHandle?.streamState({
              receivedSequence: stream.received,
              committedSequence: stream.committed,
              syncMode: stream.mode,
              syncTarget: stream.target,
            });
            diagnosticsHandle?.record("sync", { mode: control.mode, sequence: control.sequence });
          }
          if (control.type === "synced") {
            stream.finish(control.sequence);
            term.scrollToBottom();
            setConnection("connected");
            setMessage("Live");
            diagnosticsHandle?.streamState({
              receivedSequence: stream.received,
              committedSequence: stream.committed,
              syncMode: stream.mode,
              syncTarget: stream.target,
            });
            diagnosticsHandle?.update({ acceptingInput: false });
            diagnosticsHandle?.updateXterm(term);
            diagnosticsHandle?.record("synced", { sequence: control.sequence });
          }
          if (control.type === "exit") {
            showUnavailable(`Process exited with code ${control.exitCode}`);
          }
          if (control.type === "error") throw new Error(control.message);
        } finally {
          backlog.settle(queuedBytes);
          updateStreamDiagnostics();
        }
      }).catch(onStreamFailure);
    });
    socket.addEventListener("close", () => {
      diagnosticsHandle?.socketClosed(socket);
      if (!disposed && !reportedUnavailable) showUnavailable("Live preview unavailable");
    });
    socket.addEventListener("error", () => socket.close());

    const keepaliveTimer = window.setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastServerMessage > 45_000) {
        closeTerminalSocket(socket, "timeout");
        return;
      }
      socket.send(JSON.stringify({ type: "ping" } satisfies ClientTerminalMessage));
    }, 15_000);

    return () => {
      disposed = true;
      clearInterval(keepaliveTimer);
      renderDisposable.dispose();
      resizeObserver.disconnect();
      backlog.reset();
      diagnosticsHandle?.dispose();
      socket.close(1000, "Preview closed");
      term.dispose();
      xterm.current = undefined;
    };
  }, [terminal.id, mode]);

  useEffect(() => {
    if (xterm.current) {
      xterm.current.options.theme = terminalTheme(theme, terminal.color);
    }
  }, [theme, terminal.color]);

  return (
    <aside
      class={`terminal-preview terminal-preview-${mode}`}
      style={{
        "--preview-left": `${position.left}px`,
        "--preview-top": `${position.top}px`,
        "--preview-animation-duration": `${animationDuration}ms`,
        "--terminal-color": terminal.color,
        "--terminal-background": mixedTerminalBackground(theme, terminal.color),
      }}
      role="tooltip"
      data-terminal-id={terminal.id}
      data-pane-id={paneId}
      aria-label={`Live preview of ${terminal.name}`}
    >
      <header>
        <span class="terminal-preview-icon"><TerminalSquare size={14} /></span>
        <span class="terminal-preview-copy">
          <strong>{terminal.name}</strong>
          <small>{terminal.cwd}</small>
        </span>
        <span class={`terminal-preview-status ${connection}`}>
          <span />
          {message}
        </span>
      </header>
      <div class="terminal-preview-body">
        <div ref={container} class="terminal-preview-xterm" />
        {connection === "unavailable" && (
          <span class="terminal-preview-error">{message}</span>
        )}
      </div>
    </aside>
  );
}
