import { useEffect, useMemo, useState } from "preact/hooks";
import {
  CircleStop,
  ChevronDown,
  ChevronRight,
  ListTree,
  LoaderCircle,
  Radio,
  TerminalSquare,
  X,
} from "lucide-preact";
import type { ProcessRecord } from "../../shared/types";
import { api } from "../lib/api";
import {
  buildProcessTree,
  formatCpuUsage,
  formatMemory,
  type ProcessTreeItem,
} from "../lib/process-inspector";

interface ProcessInspectorProps {
  terminalId: string;
  onClose: () => void;
}

export function ProcessInspector({ terminalId, onClose }: ProcessInspectorProps) {
  const [processes, setProcesses] = useState<ProcessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [terminating, setTerminating] = useState<string | null>(null);
  const processTree = useMemo(() => buildProcessTree(processes), [processes]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    setProcesses([]);
    setLoading(true);
    setError("");

    const refresh = async () => {
      try {
        const snapshot = await api.terminalProcesses(terminalId);
        if (disposed) return;
        setProcesses(snapshot.processes);
        setError(snapshot.supported ? "" : "Process inspection is available on Linux hosts.");
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Unable to load processes");
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = window.setTimeout(refresh, 1500);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [terminalId]);

  const terminateProcess = async (process: ProcessRecord) => {
    if (!confirm(`Kill ${process.command} (PID ${process.pid})?\n\nThis sends SIGTERM to the process. Its child processes may also exit.`)) return;
    setTerminating(process.id);
    setError("");
    try {
      await api.terminateTerminalProcess(terminalId, process.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to kill process");
    } finally {
      setTerminating(null);
    }
  };

  return (
    <aside class="process-inspector" aria-label="Terminal process inspector" onPointerDown={(event) => event.stopPropagation()}>
      <header class="process-inspector-header">
        <span class="process-inspector-title"><ListTree size={15} /> Processes</span>
        <span class="process-live-label"><Radio size={10} /> live</span>
        <button class="pane-action" onClick={onClose} aria-label="Close process inspector" title="Close process inspector">
          <X size={15} />
        </button>
      </header>
      <div class="process-inspector-note">
        Live descendants from the host process table. Command input and output are not captured.
      </div>
      <div class="process-inspector-scroll">
        {error && <div class="process-inspector-error">{error}</div>}
        <section class="process-section">
          <div class="process-section-heading">
            <span>Now</span><span>{processes.length}</span>
          </div>
          {loading && !processTree.length ? (
            <div class="process-empty">Reading the process tree…</div>
          ) : processTree.length ? (
            <div class="process-tree">
              {processTree.map((item) => (
                <ProcessTreeRow
                  key={item.process.id}
                  item={item}
                  depth={0}
                  terminating={terminating}
                  onTerminate={terminateProcess}
                />
              ))}
            </div>
          ) : (
            <div class="process-empty">No running processes observed.</div>
          )}
        </section>
      </div>
    </aside>
  );
}

function ProcessTreeRow({
  item,
  depth,
  terminating,
  onTerminate,
}: {
  item: ProcessTreeItem;
  depth: number;
  terminating: string | null;
  onTerminate: (process: ProcessRecord) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <div class="process-tree-line">
        {item.children.length ? (
          <button class="process-expand" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? "Collapse children" : "Expand children"}>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : <span class="process-expand-placeholder" />}
        <ProcessRow
          process={item.process}
          depth={depth}
          terminating={terminating === item.process.id}
          disabled={terminating !== null}
          onTerminate={onTerminate}
        />
      </div>
      {expanded && item.children.map((child) => (
        <ProcessTreeRow
          key={child.process.id}
          item={child}
          depth={depth + 1}
          terminating={terminating}
          onTerminate={onTerminate}
        />
      ))}
    </>
  );
}

function ProcessRow({
  process,
  depth,
  terminating,
  disabled,
  onTerminate,
}: {
  process: ProcessRecord;
  depth: number;
  terminating: boolean;
  disabled: boolean;
  onTerminate: (process: ProcessRecord) => void;
}) {
  const commandLine = process.arguments.length ? process.arguments.join(" ") : process.command;
  return (
    <div
      class="process-row"
      style={{ "--process-depth": depth }}
      title={`${commandLine}\nCPU ${formatCpuUsage(process.cpuPercent)} · Memory ${formatMemory(process.memoryBytes)}${process.cwd ? `\n${process.cwd}` : ""}`}
    >
      <span class={`process-state ${process.foreground ? "foreground" : ""}`}>
        <TerminalSquare size={13} />
      </span>
      <span class="process-copy">
        <span class="process-command-heading">
          <span class="process-command">{process.command}</span>
          {process.foreground && <span class="process-foreground">FG</span>}
        </span>
        <span class="process-commandline">{commandLine}</span>
        <span class="process-metrics">
          <span>PID {process.pid}</span>
          <span>{formatCpuUsage(process.cpuPercent)} CPU</span>
          <span>{formatMemory(process.memoryBytes)} RAM</span>
        </span>
      </span>
      <button
        class="process-kill"
        disabled={disabled}
        onClick={() => onTerminate(process)}
        aria-label={`Kill ${process.command} process ${process.pid}`}
        title="Kill process (SIGTERM)"
      >
        {terminating ? <LoaderCircle class="spin" size={13} /> : <CircleStop size={13} />}
      </button>
    </div>
  );
}
