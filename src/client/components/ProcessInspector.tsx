import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  CornerDownLeft,
  ListTree,
  Radio,
  TerminalSquare,
  X,
} from "lucide-preact";
import type { ProcessActivityEvent, ProcessRecord } from "../../shared/types";
import { api } from "../lib/api";
import { buildRunningProcessTree, mergeProcessActivity, type ProcessTreeItem } from "../lib/process-inspector";

interface ProcessInspectorProps {
  terminalId: string;
  onClose: () => void;
}

export function ProcessInspector({ terminalId, onClose }: ProcessInspectorProps) {
  const [processes, setProcesses] = useState<ProcessRecord[]>([]);
  const [activity, setActivity] = useState<ProcessActivityEvent[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const cursor = useRef<number>();
  const runningTree = useMemo(() => buildRunningProcessTree(processes), [processes]);
  const history = useMemo(
    () => processes.filter((process) => process.status === "exited").sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0)),
    [processes],
  );
  const visibleActivity = useMemo(
    () => selectedGroup === undefined ? activity : activity.filter((event) => event.processGroup === selectedGroup),
    [activity, selectedGroup],
  );

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    cursor.current = undefined;
    setProcesses([]);
    setActivity([]);
    setLoading(true);
    setError("");

    const refresh = async () => {
      try {
        const snapshot = await api.terminalProcesses(terminalId, cursor.current);
        if (disposed) return;
        setProcesses(snapshot.processes);
        setActivity((current) => mergeProcessActivity(current, snapshot.activity, snapshot.resetActivity));
        const lastSequence = snapshot.activity.at(-1)?.sequence;
        if (lastSequence !== undefined) cursor.current = lastSequence;
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
        Activity is associated with the foreground job; PTY bytes are not exact per-process traces.
      </div>
      <div class="process-inspector-scroll">
        {error && <div class="process-inspector-error">{error}</div>}
        <section class="process-section">
          <div class="process-section-heading">
            <span>Now</span><span>{processes.filter((process) => process.status === "running").length}</span>
          </div>
          {loading && !runningTree.length ? (
            <div class="process-empty">Reading the process tree…</div>
          ) : runningTree.length ? (
            <div class="process-tree">
              {runningTree.map((item) => (
                <ProcessTreeRow
                  key={item.process.id}
                  item={item}
                  depth={0}
                  selectedGroup={selectedGroup}
                  onSelect={setSelectedGroup}
                />
              ))}
            </div>
          ) : (
            <div class="process-empty">No running processes observed.</div>
          )}
        </section>

        <section class="process-section">
          <div class="process-section-heading">
            <span>History</span><span>{history.length}</span>
          </div>
          {history.length ? (
            <div class="process-history">
              {history.map((process) => (
                <ProcessRow
                  key={process.id}
                  process={process}
                  depth={0}
                  selected={selectedGroup === process.processGroup}
                  onSelect={setSelectedGroup}
                />
              ))}
            </div>
          ) : (
            <div class="process-empty">Exited processes will remain here for this terminal’s lifetime.</div>
          )}
        </section>

        <section class="process-section process-activity-section">
          <div class="process-section-heading process-activity-heading">
            <span>Associated activity</span><span>{visibleActivity.length}</span>
          </div>
          {selectedGroup !== undefined && (
            <button class="process-filter" onClick={() => setSelectedGroup(undefined)}>
              Process group {selectedGroup} <X size={11} />
            </button>
          )}
          {visibleActivity.length ? (
            <div class="process-activity-list">
              {visibleActivity.map((event) => <ActivityEvent key={event.sequence} event={event} />)}
            </div>
          ) : (
            <div class="process-empty">No matching terminal activity retained.</div>
          )}
        </section>
      </div>
    </aside>
  );
}

function ProcessTreeRow({
  item,
  depth,
  selectedGroup,
  onSelect,
}: {
  item: ProcessTreeItem;
  depth: number;
  selectedGroup?: number;
  onSelect: (group?: number) => void;
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
          selected={selectedGroup === item.process.processGroup}
          onSelect={onSelect}
        />
      </div>
      {expanded && item.children.map((child) => (
        <ProcessTreeRow
          key={child.process.id}
          item={child}
          depth={depth + 1}
          selectedGroup={selectedGroup}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function ProcessRow({
  process,
  depth,
  selected,
  onSelect,
}: {
  process: ProcessRecord;
  depth: number;
  selected: boolean;
  onSelect: (group?: number) => void;
}) {
  const commandLine = process.arguments.length ? process.arguments.join(" ") : process.command;
  return (
    <button
      class={`process-row ${selected ? "selected" : ""} ${process.status}`}
      style={{ "--process-depth": depth }}
      onClick={() => onSelect(selected ? undefined : process.processGroup)}
      title={`${commandLine}${process.cwd ? `\n${process.cwd}` : ""}`}
    >
      <span class={`process-state ${process.foreground ? "foreground" : ""}`}>
        {process.status === "running" ? <TerminalSquare size={13} /> : <CircleStop size={12} />}
      </span>
      <span class="process-copy">
        <span class="process-command">{process.command}</span>
        <span class="process-commandline">{commandLine}</span>
      </span>
      <span class="process-pid">{process.pid}</span>
      {process.foreground && <span class="process-foreground">FG</span>}
      {process.status === "exited" && <span class="process-duration">{formatDuration(process.observedAt, process.endedAt ?? process.lastSeenAt)}</span>}
    </button>
  );
}

function ActivityEvent({ event }: { event: ProcessActivityEvent }) {
  return (
    <article class={`process-activity ${event.kind}`}>
      <header>
        <span class="process-activity-kind">
          {event.kind === "input" ? <CornerDownLeft size={11} /> : <TerminalSquare size={11} />}
          {event.kind}
        </span>
        {event.processGroup !== null && <span>job {event.processGroup}</span>}
        <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      </header>
      {event.hidden ? (
        <div class="process-activity-hidden">{event.bytes} input byte{event.bytes === 1 ? "" : "s"} hidden while terminal echo was off</div>
      ) : (
        <pre>{event.text}{event.truncated ? "\n… event truncated" : ""}</pre>
      )}
    </article>
  );
}

function formatDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
