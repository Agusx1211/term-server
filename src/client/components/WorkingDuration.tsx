import { useEffect, useState } from "preact/hooks";
import { formatWorkingDuration } from "../lib/agent-status";

export function WorkingDuration({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);

  const elapsed = formatWorkingDuration(now - since);
  return (
    <span class="agent-working-readout" aria-label={`Working for ${elapsed}`}>
      <span class="agent-working-time" aria-hidden="true">{elapsed}</span>
      <span class="agent-working-dots" aria-hidden="true">
        <span>.</span><span>.</span><span>.</span>
      </span>
    </span>
  );
}
