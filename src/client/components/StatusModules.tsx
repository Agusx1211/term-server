import { useEffect, useRef, useState } from "preact/hooks";
import type { StatusModule, StatusModulesResponse } from "../../shared/types";
import { api } from "../lib/api";
import {
  STATUS_MODULE_FALLBACK_ERROR_MESSAGE,
  markStatusModulesStale,
  parseStatusModulesResponse,
  statusModuleAccessibleLabel,
  statusModuleCompactText,
  statusModuleNextRefreshText,
  statusModulePanelId,
  statusModuleStateText,
  statusModuleUpdatedText,
  statusModulesPollDelay,
  statusModulesRetryDelay,
} from "../lib/status-modules";

interface StatusModulesProps {
  onMobileVisibilityChange: (visible: boolean) => void;
}

interface PopoverPosition {
  left: number;
  bottom: number;
}

const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 120;
const POPOVER_GUTTER_PX = 8;
const POPOVER_WIDTH_PX = 320;
const EMPTY_MODULES: StatusModule[] = [];

const MAX_STATUS_RETRY_ATTEMPT = 8;

export function StatusModules({ onMobileVisibilityChange }: StatusModulesProps) {
  const [response, setResponse] = useState<StatusModulesResponse | null>(null);
  const responseRef = useRef<StatusModulesResponse | null>(null);
  responseRef.current = response;
  const [openId, setOpenId] = useState<string | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({ left: 8, bottom: 32 });
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const hoverTimer = useRef<number>();
  const hoverCloseTimer = useRef<number>();
  const announcementTimer = useRef<number>();
  const focusPopoverRef = useRef(false);
  const focusRestoreFrame = useRef<number>();
  const pointerTypeRef = useRef<string>();
  const previousStates = useRef(new Map<string, string>());

  const clearHoverTimers = () => {
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current);
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    hoverTimer.current = undefined;
    hoverCloseTimer.current = undefined;
  };

  const positionPopover = (id: string) => {
    const trigger = triggerRefs.current.get(id);
    if (!trigger) return;
    const rectangle = trigger.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH_PX, Math.max(0, window.innerWidth - POPOVER_GUTTER_PX * 2));
    const left = Math.max(
      POPOVER_GUTTER_PX,
      Math.min(rectangle.left, window.innerWidth - width - POPOVER_GUTTER_PX),
    );
    setPopoverPosition({
      left,
      bottom: Math.max(POPOVER_GUTTER_PX, window.innerHeight - rectangle.top + POPOVER_GUTTER_PX),
    });
  };

  const openModule = (id: string, focusPopover: boolean) => {
    clearHoverTimers();
    focusPopoverRef.current = focusPopover;
    setOpenId(id);
    triggerRefs.current.get(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    positionPopover(id);
  };

  const closePopover = (restoreFocus: boolean) => {
    clearHoverTimers();
    const currentId = openId;
    focusPopoverRef.current = false;
    setOpenId(null);
    if (focusRestoreFrame.current !== undefined) {
      window.cancelAnimationFrame(focusRestoreFrame.current);
      focusRestoreFrame.current = undefined;
    }
    if (restoreFocus && currentId) {
      focusRestoreFrame.current = window.requestAnimationFrame(() => {
        triggerRefs.current.get(currentId)?.focus();
        focusRestoreFrame.current = undefined;
      });
    }
  };

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let refreshTimer: number | undefined;
    let activeController: AbortController | undefined;
    let retryAttempt = 0;

    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };

    const scheduleRefresh = (
      nextResponse: StatusModulesResponse | null,
      delayOverride?: number,
    ) => {
      clearRefreshTimer();
      if (disposed || document.visibilityState === "hidden") return;
      const delay = delayOverride
        ?? (nextResponse?.enabled ? statusModulesPollDelay(nextResponse.modules) : null);
      if (delay === null || delay === undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void fetchStatus();
      }, delay);
    };

    async function fetchStatus() {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      let shouldSchedule = true;
      let retryDelay: number | undefined;
      try {
        const nextResponse = parseStatusModulesResponse(
          await api.statusModules(controller.signal),
        );
        if (disposed) return;
        if (!nextResponse) throw new Error("Invalid status module response");
        retryAttempt = 0;
        responseRef.current = nextResponse;
        setResponse(nextResponse);
        onMobileVisibilityChange(
          nextResponse.enabled
            && nextResponse.display.showOnMobile
            && nextResponse.modules.length > 0,
        );
      } catch (error) {
        const isAbortError = error instanceof Error && error.name === "AbortError";
        if (disposed || isAbortError) {
          shouldSchedule = false;
          return;
        }
        const previous = responseRef.current;
        if (previous?.enabled && previous.modules.length > 0) {
          const stale = markStatusModulesStale(previous, undefined, retryAttempt);
          responseRef.current = stale;
          setResponse(stale);
          onMobileVisibilityChange(stale.display.showOnMobile);
        } else {
          responseRef.current = null;
          setResponse(null);
          onMobileVisibilityChange(false);
        }
        retryDelay = statusModulesRetryDelay(retryAttempt);
        retryAttempt = Math.min(retryAttempt + 1, MAX_STATUS_RETRY_ATTEMPT);
      } finally {
        inFlight = false;
        if (activeController === controller) activeController = undefined;
        if (!disposed && shouldSchedule) {
          scheduleRefresh(responseRef.current, retryDelay);
        }
      }
    }

    const handleVisibilityChange = () => {
      clearRefreshTimer();
      if (document.visibilityState === "visible") void fetchStatus();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void fetchStatus();
    return () => {
      disposed = true;
      clearRefreshTimer();
      activeController?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      onMobileVisibilityChange(false);
    };
  }, [onMobileVisibilityChange]);

  const modules = response?.enabled ? response.modules : EMPTY_MODULES;

  useEffect(() => {
    const currentStates = new Map(modules.map((module) => [module.id, module.state]));
    const transition = modules.find((module) => {
      const previous = previousStates.current.get(module.id);
      return previous !== undefined
        && previous !== module.state
        && (module.state === "warn" || module.state === "error" || module.state === "unconfigured");
    });
    previousStates.current = currentStates;
    if (!transition) return;
    if (announcementTimer.current !== undefined) window.clearTimeout(announcementTimer.current);
    setAnnouncement(`${transition.label}: ${statusModuleStateText(transition)}`);
    announcementTimer.current = window.setTimeout(() => {
      setAnnouncement("");
      announcementTimer.current = undefined;
    }, 4_000);
  }, [modules]);

  useEffect(() => {
    if (openId && !modules.some((module) => module.id === openId)) setOpenId(null);
  }, [openId, modules]);

  useEffect(() => {
    if (!openId) return;
    const updatePosition = () => positionPopover(openId);
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    let frame: number | undefined;
    if (focusPopoverRef.current) {
      focusPopoverRef.current = false;
      frame = window.requestAnimationFrame(() => popoverRef.current?.focus());
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [openId]);

  useEffect(() => {
    if (!openId) return;
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover(false);
    };
    const handleDocumentFocusIn = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover(false);
    };
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover(true);
      }
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("focusin", handleDocumentFocusIn);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("focusin", handleDocumentFocusIn);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [openId]);

  useEffect(() => () => {
    clearHoverTimers();
    if (announcementTimer.current !== undefined) window.clearTimeout(announcementTimer.current);
    if (focusRestoreFrame.current !== undefined) window.cancelAnimationFrame(focusRestoreFrame.current);
  }, []);

  if (modules.length === 0) return null;
  const openModuleData = modules.find((module) => module.id === openId);

  const beginHover = (module: StatusModule, event: PointerEvent) => {
    pointerTypeRef.current = event.pointerType;
    if (event.pointerType === "touch") return;
    clearHoverTimers();
    hoverTimer.current = window.setTimeout(() => {
      openModule(module.id, false);
      pointerTypeRef.current = undefined;
      hoverTimer.current = undefined;
    }, HOVER_OPEN_DELAY_MS);
  };

  const leaveHover = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    pointerTypeRef.current = undefined;
    hoverCloseTimer.current = window.setTimeout(() => {
      if (!popoverRef.current?.matches(":hover")) setOpenId(null);
      hoverCloseTimer.current = undefined;
    }, HOVER_CLOSE_DELAY_MS);
  };

  const toggleModule = (module: StatusModule, focusPopover: boolean) => {
    if (openId === module.id) closePopover(focusPopover);
    else openModule(module.id, focusPopover);
  };

  return (
    <div ref={rootRef} class="statusbar-modules" role="group" aria-label="Service limits">
      <div class="statusbar-modules-scroll">
        {modules.map((module) => {
          const panelId = statusModulePanelId(module.id);
          return (
            <button
              key={module.id}
              ref={(element) => {
                if (element) triggerRefs.current.set(module.id, element);
                else triggerRefs.current.delete(module.id);
              }}
              class={`status-module status-module-${module.state}`}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={openId === module.id}
              aria-controls={panelId}
              aria-label={statusModuleAccessibleLabel(module)}
              title={module.label}
              onPointerDown={(event) => { pointerTypeRef.current = event.pointerType; }}
              onPointerEnter={(event) => beginHover(module, event)}
              onPointerLeave={leaveHover}
              onClick={() => {
                if (pointerTypeRef.current !== "keyboard") toggleModule(module, false);
                pointerTypeRef.current = undefined;
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                pointerTypeRef.current = "keyboard";
                openModule(module.id, true);
              }}
            >
              <span class="status-module-state" aria-hidden="true" />
              <span class="status-module-text">{statusModuleCompactText(module)}</span>
            </button>
          );
        })}
      </div>
      {openModuleData && (
        <div
          ref={popoverRef}
          id={statusModulePanelId(openModuleData.id)}
          class={`status-module-popover status-module-popover-${openModuleData.state}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${statusModulePanelId(openModuleData.id)}-title`}
          tabIndex={-1}
          style={{ left: `${popoverPosition.left}px`, bottom: `${popoverPosition.bottom}px` }}
          onPointerEnter={clearHoverTimers}
          onPointerLeave={leaveHover}
        >
          <header class="status-module-popover-header">
            <strong id={`${statusModulePanelId(openModuleData.id)}-title`}>{openModuleData.label}</strong>
            <span>{statusModuleStateText(openModuleData)}</span>
          </header>
          {openModuleData.details.length > 0 && (
            <dl class="status-module-details">
              {openModuleData.details.map((detail) => (
                <div key={`${detail.label}:${detail.value}`}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div class="status-module-refresh">
            <span>Updated {statusModuleUpdatedText(openModuleData.refresh.updatedAt)}</span>
            <span>Next refresh {statusModuleNextRefreshText(openModuleData.refresh.nextAt)}</span>
            <span>Every {openModuleData.refresh.intervalSeconds}s</span>
            {openModuleData.refresh.stale && <span class="status-module-stale">Stale data</span>}
          </div>
          {openModuleData.error && (
            <p class="status-module-error">
              {openModuleData.error.message || STATUS_MODULE_FALLBACK_ERROR_MESSAGE}
            </p>
          )}
          {openModuleData.details.length === 0 && !openModuleData.error && (
            <p class="status-module-empty">No additional service details are available.</p>
          )}
        </div>
      )}
      <span class="visually-hidden" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
