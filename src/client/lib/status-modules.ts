import type {
  StatusModule,
  StatusModuleDetail,
  StatusModuleError,
  StatusModuleState,
  StatusModulesResponse,
} from "../../shared/types";

export const STATUS_MODULE_DEFAULT_INTERVAL_SECONDS = 300;
export const STATUS_MODULE_MIN_POLL_DELAY_MS = 1_000;
export const STATUS_MODULE_RETRY_BASE_DELAY_MS = 2_000;
export const STATUS_MODULE_RETRY_MAX_DELAY_MS = 30_000;
export const STATUS_MODULE_FALLBACK_ERROR_MESSAGE = "Unable to refresh service status right now.";

function unixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

const statusModuleStates: Record<StatusModuleState, true> = {
  ok: true,
  warn: true,
  error: true,
  unconfigured: true,
};

const secretLikeError = /(?:bearer\s+\S+|(?:api[_-]?key|access[_-]?token|authorization|secret|password)\s*[:=]\s*\S+|https?:\/\/\S+)/i;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function safeText(value: unknown, fallback = "", maximum = 240): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function safeError(value: unknown): StatusModuleError | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (!input) return null;
  const message = safeText(input.message, STATUS_MODULE_FALLBACK_ERROR_MESSAGE, 180);
  const code = safeText(input.code, "status-error", 48).replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    code: code || "status-error",
    message: secretLikeError.test(message) ? STATUS_MODULE_FALLBACK_ERROR_MESSAGE : message,
    retryable: input.retryable === true,
  };
}

function parseDetail(value: unknown): StatusModuleDetail | null {
  const input = record(value);
  if (!input) return null;
  const label = safeText(input.label);
  const detailValue = safeText(input.value);
  if (!label || !detailValue || secretLikeError.test(label) || secretLikeError.test(detailValue)) return null;
  return { label, value: detailValue };
}

function parseModule(value: unknown): StatusModule | null {
  const input = record(value);
  if (!input) return null;
  const id = safeText(input.id, "", 96);
  const label = safeText(input.label, "", 96);
  const provider = safeText(input.provider, "", 96);
  const state = input.state;
  if (!id || !label || !provider || typeof state !== "string" || statusModuleStates[state as StatusModuleState] !== true) {
    return null;
  }

  const primary = input.primary === null || input.primary === undefined
    ? null
    : safeText(input.primary, "", 180) || null;
  const details = Array.isArray(input.details)
    ? input.details.map(parseDetail).filter((detail): detail is StatusModuleDetail => detail !== null).slice(0, 24)
    : [];
  const refreshInput = record(input.refresh);
  const intervalSeconds = finiteNumber(refreshInput?.intervalSeconds) ?? STATUS_MODULE_DEFAULT_INTERVAL_SECONDS;
  const refresh = {
    updatedAt: nullableTimestamp(refreshInput?.updatedAt),
    nextAt: nullableTimestamp(refreshInput?.nextAt),
    intervalSeconds: Math.min(86_400, Math.max(1, intervalSeconds)),
    stale: refreshInput?.stale === true,
  };

  return {
    id,
    label,
    provider,
    state: state as StatusModuleState,
    primary,
    details,
    refresh,
    error: safeError(input.error),
  };
}

/** Normalize the server response without ever exposing malformed or secret-like fields. */
export function parseStatusModulesResponse(
  value: unknown,
  now = unixSeconds(),
): StatusModulesResponse | null {
  const input = record(value);
  if (!input || typeof input.enabled !== "boolean" || !Array.isArray(input.modules)) return null;
  const modules: StatusModule[] = [];
  const seen = new Set<string>();
  for (const candidate of input.modules) {
    const module = parseModule(candidate);
    if (!module || seen.has(module.id)) continue;
    seen.add(module.id);
    modules.push(module);
  }
  const displayInput = record(input.display);
  const generatedAt = finiteNumber(input.generatedAt) ?? now;
  return {
    enabled: input.enabled,
    display: { showOnMobile: displayInput?.showOnMobile === true },
    modules,
    generatedAt,
  };
}

export function statusModuleValue(module: StatusModule): string {
  switch (module.state) {
    case "unconfigured": return "Not configured";
    case "error": return "Unavailable";
    case "warn": return module.primary?.trim() || (module.refresh.stale ? "Stale" : "Limited");
    case "ok": return module.primary?.trim() || "Unavailable";
  }
}

export function statusModuleStateText(module: StatusModule): string {
  switch (module.state) {
    case "ok": return "OK";
    case "warn": return module.refresh.stale ? "Stale" : "Limited";
    case "error": return "Unavailable";
    case "unconfigured": return "Not configured";
  }
}

export function statusModuleCompactText(module: StatusModule): string {
  const label = module.label.trim() || "Service";
  switch (module.state) {
    case "ok": return `${label} ${statusModuleValue(module)}`;
    case "warn": return `${label} ${statusModuleValue(module)} · ${module.refresh.stale ? "stale" : "limited"}`;
    case "error": return `${label} unavailable`;
    case "unconfigured": return `${label} setup`;
  }
}

export function statusModuleUpdatedText(updatedAt: number | null, now = unixSeconds()): string {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return "not yet updated";
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 5) return "just now";
  if (elapsed < 60) return `${Math.floor(elapsed)}s ago`;
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h ago`;
  return `${Math.floor(elapsed / 86_400)}d ago`;
}

export function statusModuleNextRefreshText(nextAt: number | null, now = unixSeconds()): string {
  if (nextAt === null || !Number.isFinite(nextAt)) return "not scheduled";
  const remaining = Math.max(0, nextAt - now);
  if (remaining < 5) return "now";
  if (remaining < 60) return `in ${Math.ceil(remaining)}s`;
  if (remaining < 3_600) return `in ${Math.ceil(remaining / 60)}m`;
  return `in ${Math.ceil(remaining / 3_600)}h`;
}

export function statusModuleAccessibleLabel(module: StatusModule, now = unixSeconds()): string {
  return `${module.label} usage: ${statusModuleValue(module)}; state ${statusModuleStateText(module)}; updated ${statusModuleUpdatedText(module.refresh.updatedAt, now)}`;
}

/** Return the next delay, ignoring modules that must not trigger network work. */
export function statusModulesPollDelay(
  modules: StatusModule[],
  now = unixSeconds(),
): number | null {
  let earliest: number | null = null;
  for (const module of modules) {
    if (module.state === "unconfigured"
      || (module.state === "error" && module.error?.retryable === false)) {
      continue;
    }
    const interval = Math.max(1, module.refresh.intervalSeconds);
    const target = module.refresh.nextAt ?? now + interval;
    const delay = Math.max(STATUS_MODULE_MIN_POLL_DELAY_MS, (target - now) * 1_000);
    if (earliest === null || delay < earliest) earliest = delay;
  }
  return earliest;
}

/** Bound transport retry pressure without changing the configured refresh cadence. */
export function statusModulesRetryDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  return Math.min(
    STATUS_MODULE_RETRY_MAX_DELAY_MS,
    STATUS_MODULE_RETRY_BASE_DELAY_MS * 2 ** Math.min(4, safeAttempt),
  );
}

export function markStatusModulesStale(
  response: StatusModulesResponse,
  now = unixSeconds(),
  retryAttempt = 0,
): StatusModulesResponse {
  return {
    ...response,
    modules: response.modules.map((module) => {
      if (module.state === "unconfigured") return module;
      return {
        ...module,
        state: module.primary ? "warn" : "error",
        refresh: {
          ...module.refresh,
          nextAt: now + Math.max(1, Math.ceil(statusModulesRetryDelay(retryAttempt) / 1_000)),
          stale: true,
        },
        error: {
          code: "transport",
          message: STATUS_MODULE_FALLBACK_ERROR_MESSAGE,
          retryable: true,
        },
      };
    }),
  };
}

export function statusModulePanelId(id: string): string {
  return `status-module-detail-${encodeURIComponent(id)}`;
}
