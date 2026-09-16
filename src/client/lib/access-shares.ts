import type { SecretShare } from "../../shared/types";

/** Pending offers first (oldest first, so the queue reads top-down), then the newest history. */
export function orderShares(shares: readonly SecretShare[]): SecretShare[] {
  return [...shares].sort((left, right) => {
    const leftPending = left.state === "pending" ? 0 : 1;
    const rightPending = right.state === "pending" ? 0 : 1;
    if (leftPending !== rightPending) return leftPending - rightPending;
    return leftPending === 0 ? left.createdAt - right.createdAt : right.createdAt - left.createdAt;
  });
}

export function shareOutcome(share: Pick<SecretShare, "state">): string {
  switch (share.state) {
    case "viewed":
      return "Revealed once; the broker no longer holds a copy for you.";
    case "dismissed":
      return "Dismissed without viewing; the agent was told.";
    case "expired":
      return "Expired unviewed; ask the agent to share it again.";
    default:
      return "";
  }
}

export function untilTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.floor((timestamp - now) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
