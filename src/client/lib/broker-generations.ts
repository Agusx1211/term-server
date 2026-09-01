import type {
  SessionBrokerGenerationInfo,
  SessionBrokerInfo,
  TerminalInfo,
} from "../../shared/types";
import { structurallyEqual } from "./structural-equality";

const buildKey = ({ version, commit }: { version: string; commit: string }) =>
  `${version}\u0000${commit}`;

export function withBrokerSessions(
  broker: SessionBrokerInfo,
  terminals: TerminalInfo[],
): SessionBrokerInfo {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    if (!terminal.broker) continue;
    const key = buildKey(terminal.broker);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const generations = broker.generations.map((generation) => ({
    ...generation,
    sessions: counts.get(buildKey(generation)) ?? 0,
  }));
  const known = new Set(generations.map(buildKey));
  for (const terminal of terminals) {
    if (!terminal.broker || known.has(buildKey(terminal.broker))) continue;
    const generation: SessionBrokerGenerationInfo = {
      ...terminal.broker,
      sessions: counts.get(buildKey(terminal.broker)) ?? 0,
      current: terminal.broker.version === broker.version
        && terminal.broker.commit === broker.commit,
    };
    generations.push(generation);
    known.add(buildKey(generation));
  }

  const updated: SessionBrokerInfo = {
    ...broker,
    sessions: terminals.length,
    restartRequired: generations.some(
      (generation) => !generation.current && generation.sessions > 0,
    ),
    generations,
  };
  // The workspace poll recomputes this every 1.5 s; keeping the previous object
  // when nothing moved lets the config state update bail out instead of
  // re-rendering the whole workbench.
  return structurallyEqual(broker, updated) ? broker : updated;
}
