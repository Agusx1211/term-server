export const SUPERVISOR_REQUEST_TIMEOUT_MS = 10_000;

/** Abort a supervisor creation request that has stopped making progress. */
export function armSupervisorRequestTimeout(
  controller: AbortController,
  timeout = SUPERVISOR_REQUEST_TIMEOUT_MS,
): () => void {
  const timer = globalThis.setTimeout(() => controller.abort(), timeout);
  return () => globalThis.clearTimeout(timer);
}
