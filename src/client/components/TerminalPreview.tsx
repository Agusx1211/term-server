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
import { closeTerminalSocket } from "../lib/terminal-socket";
import { TerminalStreamState, decodeTerminalFrame } from "../lib/terminal-stream";
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
  const xterm = useRef<XTerm>();
  const [connection, setConnection] = useState<PreviewConnection>("connecting");
  const [message, setMessage] = useState("Connecting live preview…");

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let reportedUnavailable = false;
    let cols = 80;
    let rows = 24;
    let lastServerMessage = Date.now();
    const term = new XTerm({
      cols,
      rows,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: mode === "large" ? 15 : 11,
      letterSpacing: 0,
      lineHeight: 1.15,
      minimumContrastRatio: 1,
      scrollback: 0,
      theme: terminalTheme(theme, terminal.color),
    });
    xterm.current = term;
    term.open(host);

    const fitExistingGrid = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      const fontSize = terminalPreviewFontSize(
        cols,
        rows,
        host.clientWidth,
        host.clientHeight,
        mode,
      );
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    };
    const resizeObserver = new ResizeObserver(fitExistingGrid);
    resizeObserver.observe(host);
    fitExistingGrid();

    const stream = new TerminalStreamState();
    let messageQueue = Promise.resolve();
    const writeTerminal = (data: Uint8Array, commit?: number) => new Promise<void>(
      (resolve, reject) => {
        try {
          term.write(data, () => {
            try {
              if (commit !== undefined) stream.commit(commit);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        } catch (error) {
          reject(error);
        }
      },
    );

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/api/terminals/${terminal.id}/socket`);
    url.searchParams.set("observer", "true");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const showUnavailable = (value: string) => {
      reportedUnavailable = true;
      setConnection("unavailable");
      setMessage(value);
    };

    socket.addEventListener("message", (event) => {
      lastServerMessage = Date.now();
      messageQueue = messageQueue.then(async () => {
        if (disposed) return;
        const binary = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        if (binary instanceof ArrayBuffer) {
          const frame = decodeTerminalFrame(binary);
          await writeTerminal(frame.data, stream.accept(frame));
          return;
        }
        const control = JSON.parse(String(event.data)) as ServerTerminalMessage;
        if (control.type === "size") {
          cols = control.cols;
          rows = control.rows;
          term.resize(cols, rows);
          fitExistingGrid();
        }
        if (control.type === "sync" && stream.begin(control.mode, control.sequence)) {
          term.reset();
        }
        if (control.type === "synced") {
          stream.finish(control.sequence);
          term.scrollToBottom();
          setConnection("connected");
          setMessage("Live");
        }
        if (control.type === "exit") {
          showUnavailable(`Process exited with code ${control.exitCode}`);
        }
        if (control.type === "error") throw new Error(control.message);
      }).catch((error) => {
        if (disposed) return;
        showUnavailable(error instanceof Error ? error.message : "Preview unavailable");
        closeTerminalSocket(socket, "protocol-error");
      });
    });
    socket.addEventListener("close", () => {
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
      resizeObserver.disconnect();
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
