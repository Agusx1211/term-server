export function formatWorkingDuration(elapsedMilliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMilliseconds) / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes === 0) return `${seconds}s`;

  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;

  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  if (totalHours < 24) return `${hours}h ${String(minutes).padStart(2, "0")}m`;

  const days = Math.floor(totalHours / 24);
  return `${days}d ${String(hours).padStart(2, "0")}h`;
}
