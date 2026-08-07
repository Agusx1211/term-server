# Changelog

## Unreleased

### Added

- Agents now have a **blocked** state. An agent waiting on an approval, a question, or a menu is
  marked **Needs you** in the sidebar and pane header for as long as it waits, distinct from working
  and idle. Previously a permission prompt left the agent looking busy, with no bell, no sidebar
  signal, and no notification for the one state that actually needs a person. Unlike a completion, a
  block is not dismissed by looking at the terminal, because the agent is still waiting no matter who
  looked.
- Blocked agents raise the same alerts as completions — in-app cards, desktop notifications, and
  Pushover — announced immediately rather than waiting for a Pi summary.
- Screen-based agent detection. For agents whose integration hooks do not cover the whole lifecycle,
  term-server now matches the visible agent UI on the live screen against a per-agent manifest of
  priority-ordered rules scoped to structural screen regions (the prompt box, the text below the last
  horizontal rule, the window title). Detection self-clears when the prompt does, which hooks alone
  cannot do reliably.
- Detection manifests can be replaced per agent at
  `~/.config/term-server/agent-detection/<agent>.toml`, so detection can be corrected for a new agent
  release without waiting for a term-server update. An invalid or oversized override is ignored with
  a warning and the bundled rules stay in use.
- `GET /api/terminals/{id}/agent/explain` reports the screen the detection rules ran against, the
  retained OSC title and progress, which rule decided the status, and how every rule evaluated.

### Changed

- Codex's `Action Required` window title is now read as blocked. It was previously treated as idle.
- The sidebar and pane header agent badges share one presentation helper instead of duplicating the
  label and icon logic.

### Credits

- The detection manifest format and the bundled Claude Code, Codex, and Pi rule sets are ported from
  [herdr](https://github.com/herdrdev/herdr) under the Apache License 2.0. See `NOTICE`. The
  detection engine is an independent implementation.

## 0.9.0 - 2026-08-07

### Fixed

- Terminals running full-screen TUIs no longer settle into a loop of "Catching up"
  reconnects with duplicated and stale content on screen. Programs like pi and btop repaint
  their whole history in a single burst, 1.3 MB in about 70 ms in the recording this was
  diagnosed from, and three separate limits turned that burst into a loop that fed itself. A
  capture of the stuck state shows 18 reconnects and 14 full snapshot resynchronizations in
  16 seconds.
- The browser handed xterm one websocket frame at a time and waited for the parser before
  writing the next one, which caps a pane at roughly one 4 KB frame per event loop turn.
  Measured against the recorded stream, that is 1.9 MB/s where the same frames pipelined
  reach 11 MB/s and coalesced reach 20 MB/s. Frames are now written as they arrive. Control
  messages still wait for the writes ahead of them, so a reset or a resize never lands on a
  buffer that still has unparsed output queued behind it.
- The render backlog watchdog abandoned the socket at 512 KB of pending output, and the
  reconnect pulled a full snapshot that cost more than the burst it was avoiding. It also
  measured backlog age from the last moment the backlog stood empty, so a terminal that never
  goes idle could be disconnected while keeping up perfectly well. It now dates the oldest
  unparsed frame, and its bounds leave room for a full screen repaint.
- The per terminal event channel held 256 events while a repaint produces around 320, so the
  server independently resynchronized every connected client mid burst. The channel is larger,
  and a subscriber now merges whatever output is already queued into full frames before
  sending, so a burst reaches the browser as a few dozen websocket messages instead of a few
  hundred. Frames grow only while a client is behind, and shrink back to one pty read once it
  catches up.

### Known issues

- A snapshot resynchronization still replaces the browser scrollback with the server's
  canonical terminal state, which holds 1536 rows at 211 columns against the 200000 rows the
  browser is configured to keep. Resynchronizations are rare now instead of roughly one per
  second, but scrollback is still truncated when one happens.

## 0.8.3 - 2026-08-06

### Added

- Debug recording now captures the rendered terminal state alongside the byte stream: the xterm
  viewport (buffer lines, cursor, viewport offset), a PNG screenshot of the terminal canvas, the
  active renderer (WebGL loaded, context loss, device pixel ratio), and pane visibility changes.
  This localizes a rendering bug to the client model versus the paint layer. Capture only runs while
  a recording is active.
- OMP (the agent harness) is now a first-class agent integration alongside Codex, Claude Code, and
  Pi, installable from the settings panel, with native lifecycle activity reported to the dashboard.
- OMP conversations reuse the title OMP already generates from the first message, so term-server no
  longer generates its own title for OMP sessions.

### Fixed

- The client no longer throws when reading update settings before the workspace configuration
  loads (for example in development builds), because the update-check effect now tolerates a missing
  `updates` block.

## 0.8.2 - 2026-08-06

### Fixed

- Terminals no longer render duplicated or stale content after a resize followed by a
  reconnect (switching tabs, a background pane returning, or a dropped socket). A resize
  reflows the browser terminal buffer away from the server's canonical state, so the next
  reconnect now pulls a fresh snapshot instead of resuming delta output onto a stale grid.

## 0.8.1 - 2026-08-06

### Added

- On-demand debug recording: start a recording from Settings, reproduce a terminal
  rendering problem, then stop and download a single JSON trace combining the server-side
  byte stream and the browser-side view for side-by-side comparison. Recording is off by
  default and only captures while active, so it has no steady-state cost.
- Pushover notifications: configure Pushover user and application keys and a delivery scope
  (off, select, or all). In select and all modes a per-terminal bell in the sidebar (on by
  default for all, off by default for select) controls which terminals are included. When an
  agent finishes, a Pushover alert is sent with the host, agent kind, working directory, and
  terminal title.

## 0.8.0 - 2026-08-03

Terminal rendering and interaction now remain stable across resizes, reconnects, background panes,
and demanding full-screen terminal applications.

### Added

- Browser terminals use a generated Unicode 17 width table that exactly matches the server's
  canonical terminal, including combining characters and modern emoji.
- The server answers standard terminal identity, status, cursor-position, mode, and window-size
  queries even while no browser renderer is connected.
- Development servers now start with an isolated temporary data directory and session broker by
  default, protecting the production instance on the same machine.

### Changed

- Canonical reconnect state reflows complete logical lines and preserves scroll margins, origin and
  insert modes, saved cursors and attributes, alternate-screen state, split UTF-8 input, and pending
  autowrap.
- Terminal input uses bounded asynchronous writes and raw WebSocket frames, allowing mouse reports
  and large pastes without blocking the runtime or corrupting bytes.
- Hidden cached panes detach from their terminal streams and reconnect when shown. Viewport updates
  now settle before resize and include cell-grid pixel dimensions.
- Live previews account for every framed output byte before acknowledging their backlog.
- WebSocket streams have bounded send times and liveness leases, and the container image now
  includes a UTF-8 locale and common terminal definitions.

### Fixed

- Resizing or reconnecting no longer loses, shifts, duplicates, or incorrectly unwraps text,
  including content inside scrolling regions and alternate-screen TUIs.
- Real keystrokes and paste data are no longer dropped while xterm.js is parsing output, and binary
  mouse input is forwarded without UTF-8 conversion.
- Browser and server character widths no longer drift on emoji, combining marks, or newer Unicode
  code points.
- Output and resize events can no longer be reordered, interrupted PTY reads no longer look like
  EOF, and slow PTY writes no longer block unrelated terminal work.
- Background panes no longer steal focus or accumulate stale output, and resize storms are
  coalesced.
- SGR true-color sequences containing zero-valued RGB components no longer reset terminal
  attributes, and cursor-position reports respect origin mode.

### Upgrade notes

- This release intentionally advances the session broker protocol. Updating closes existing
  terminal sessions; no configuration or data migration is required.
- Browser terminal stream compatibility also advances. Tabs opened before the update must be
  reloaded once and will disconnect cleanly instead of sending duplicate query responses.
- Automatic installation over `0.7.6` is otherwise safe. Newly opened terminals use the corrected
  rendering, input, and reconnect behavior immediately.

## 0.7.6 - 2026-08-01

Terminals reopened after the browser was closed now retain substantially more of the output produced
while no renderer was connected.

### Changed

- Canonical reconnect history is sized from the terminal's actual width in bounded buckets instead
  of reserving every row for the maximum 500-column viewport.
- Width changes rebalance retained history so typical terminals gain capacity without exceeding the
  configured reconnect-state memory budget.

### Fixed

- A fresh browser connection no longer loses most detached terminal output because of an overly
  conservative server-side row limit. With the default 16 MiB budget, a typical terminal now keeps
  about four times as many reconnect-history rows.

### Upgrade notes

- There are no breaking changes, configuration changes, data migrations, or session broker protocol
  changes.
- Automatic installation over `0.7.5` is safe. Existing terminals continue on their current broker
  generation and keep its previous history limit; newly created terminals use the expanded reconnect
  history immediately.

## 0.7.5 - 2026-07-31

Terminal pages left open across the `0.5.0` to `0.6.0` stream protocol transition now stop
cleanly instead of rendering binary frame metadata as typed characters.

### Changed

- Browser terminal and live-preview WebSockets identify support for framed terminal output.
- The `0.7.4` keypress workaround has been removed. xterm.js handles keyboard events directly
  again because the reported character interleaving came from a stale stream client, not duplicate
  Linux keyboard events.

### Fixed

- Servers reject incompatible browser clients before sending framed terminal output, preventing
  sequence bytes such as `H`, `I`, `J`, and `K` from appearing between typed characters.
- A stale browser page now receives an upgrade-required response instead of silently corrupting
  terminal output after a server update.

### Upgrade notes

- There are no configuration changes, data migrations, or session broker protocol changes.
- Automatic installation over `0.7.4` is safe and existing terminal sessions remain open.
- Browser tabs opened before the update must be reloaded once. Incompatible tabs now disconnect
  instead of rendering corrupted terminal output.

## 0.7.4 - 2026-07-31

Compatible updates now preserve existing terminal sessions, and Linux Chromium browsers no longer
duplicate or interleave typed characters.

### Added

- Terminal headers and Settings identify terminals connected to an older session broker generation.

### Changed

- Compatible session broker builds coexist during updates. Existing terminals stay on their
  original broker, new terminals use the current build, and drained brokers exit after their final
  terminal closes.
- Cloning, rename and remove operations, process inspection, WebSocket routing, Pi settings, and
  duplicate-name checks work across broker generations.
- Protocol-incompatible upgrades retain the existing forced-restart behavior.

### Fixed

- Linux Chromium keyboard event sequences no longer send both a handled `keydown` and its matching
  `keypress` to the terminal, preventing duplicated or interleaved input.

### Upgrade notes

- There are no breaking changes, configuration changes, data migrations, or broker protocol
  changes.
- Automatic installation over `0.7.3` is safe. Existing terminals continue on the previous broker
  until they close, while new terminals use `0.7.4`.
- Reload the browser client to apply the keyboard input fix.

## 0.7.3 - 2026-07-31

Codex and similar normal-screen TUIs now keep their transcript intact when a browser renderer
recovers after a resize or a period in the background.

### Changed

- Canonical terminal state now follows xterm behavior when a TUI scrolls a top-anchored region
  while keeping a composer, status bar, or footer fixed.

### Fixed

- Snapshot recovery preserves rows inserted through a partial scroll region instead of returning
  only the current viewport.
- `CSI 3J` clears saved lines in canonical state, so a TUI resize replay replaces stale history
  instead of retaining or duplicating it.
- Codex resize replay remains reconstructable when its clear sequence is split across output
  frames.

### Upgrade notes

- There are no breaking changes, configuration changes, data migrations, or broker protocol
  changes.
- Restart the session broker from Settings at a convenient time to apply the canonical terminal
  fix to existing sessions; restarting the broker closes open terminals.
- The release is safe for automatic installation over `0.7.2`.

## 0.7.2 - 2026-07-31

High-frequency TUIs no longer leave background terminal panes replaying stale redraws
indefinitely, and stream recovery is now visible in the workspace.

### Added

- Terminal pane headers show **Catching up** while the renderer loads current terminal state.
- The bottom status bar reports how many terminal streams are recovering or reconnecting. Its
  tooltip identifies the affected terminals and, when available, how much stale output was
  discarded.

### Changed

- Browser renderers bound their pending xterm.js work by bytes, age, and frame count. When a
  renderer cannot keep up, it drops obsolete queued redraws and reconnects from a fresh canonical
  snapshot.
- Server-side lag recovery now skips directly to the current canonical snapshot instead of
  replaying retained output that is already stale.

### Fixed

- Websocket messages can no longer accumulate in an unbounded browser Promise chain while xterm.js
  is throttled or parsing a redraw-heavy TUI.
- A slow terminal consumer now converges on the current screen instead of repeatedly falling
  further behind while replaying old deltas.
- Terminal stream disconnects are visible outside the pane instead of being represented only by
  the small connection dot.

### Upgrade notes

- There are no breaking changes, configuration changes, data migrations, or broker protocol
  changes.
- The browser-side recovery takes effect after the updated client loads. Restart the session broker
  from Settings at a convenient time to apply server-side snapshot recovery to existing
  installations; restarting the broker closes open terminals.
- The release is safe for automatic installation over `0.7.1`.

## 0.7.1 - 2026-07-30

Live terminal previews can now be disabled and tuned for each browser.

### Added

- Settings → Terminal behavior includes an explicit toggle for live hover previews.
- Hover delay is adjustable from immediate to one second.
- Fade-in duration is adjustable from off to 400 milliseconds, with a reset action for all preview
  controls.
- Server operators can set the mounted terminal renderer cache per browser tab with
  `--cached-terminals` or `TERM_SERVER_CACHED_TERMINALS`.

### Changed

- Preview enabled state, compact or large size, hover delay, and animation duration are stored
  together as one browser preference.
- Existing compact or large preferences are migrated automatically.

### Fixed

- Turning previews off immediately cancels pending hover timers and closes any visible preview,
  preventing new observer connections while disabled.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- The new renderer cache setting defaults to six terminals, matching the previous behavior, so no
  configuration change is required.
- No additional broker restart is required after `0.7.0`. If the broker has not been restarted since
  installing `0.7.0`, restart it from Settings before enabling previews.
- The release is safe for automatic installation over `0.7.0`.

## 0.7.0 - 2026-07-30

Terminals now have live hover previews, and unread agent and long-command completions stay
synchronized across browsers and machines.

### Added

- Hovering a terminal in the workspace sidebar opens a live, read-only preview after a short delay.
- Settings → Terminal behavior selects either a compact card beside the terminal row or a large
  modal-size preview over the workspace. The choice persists in the browser.
- Preview renderers receive the terminal's canonical screen, dimensions, and live output without
  attaching as interactive terminal clients.

### Changed

- Hover previews fit the terminal's existing grid by scaling their local font instead of reporting
  the preview dimensions to the PTY.
- Viewing an agent **Ready** state or completed long command advances a server-owned watermark that
  every connected browser receives on its normal terminal refresh.
- Completion watermarks are stored atomically in the term-server data directory and survive web
  process restarts while the private session broker keeps terminals running.
- Existing per-browser viewed state is migrated to the server on first load after upgrading.

### Fixed

- Opening or closing a hover preview cannot resize the original terminal or affect viewport,
  controller, and responder selection.
- A completion acknowledged on one machine no longer remains unread on every other machine.
- Stale browser requests and out-of-order terminal refreshes cannot move an acknowledgment backward
  or hide newer work.
- Starting a new agent lifecycle in the same terminal cannot inherit an unrelated viewed revision
  and suppress its next **Ready** state.
- Closing a terminal pane no longer treats later activity as viewed while the pane stays hidden.
- Interactive alternate-screen applications remain **Live** without an elapsed counter and never
  create a completed or unread watermark when they exit.

### Security

- Preview sockets use a dedicated read-only observer route. The server rejects input, resize, and
  focus messages from observers.
- Completion acknowledgment updates require authentication and a same-origin request.
- The server rejects watermarks newer than the completion currently observable in the terminal.
- The persisted activity file is written atomically with owner-only permissions.

### Upgrade notes

- There are no breaking changes, configuration changes, or manual data migrations.
- This release keeps session broker protocol 3. Updating from `0.6.0` preserves the existing broker
  and terminal processes, so synchronized completion state works immediately.
- Hover previews require the `0.7.0` broker observer route. After upgrading, restart the session
  broker from Settings when existing terminal work can be closed.
- The release is safe for automatic installation over `0.6.0`; previews remain unavailable until
  the broker is restarted.

## 0.6.0 - 2026-07-30

Terminal reconnections now resume from compact canonical state instead of replaying the entire
session history, and long foreground work is visible without treating interactive TUIs as finished
commands.

### Added

- On Linux, foreground commands that run for at least five seconds show their name and elapsed time
  in the sidebar and pane header. The browser tab count includes them alongside working agents.
- Completed long-running commands use the existing unread bell, in-app toast, and desktop
  notification preferences.
- Interactive applications that enter the terminal alternate screen are marked **Live** without an
  elapsed counter and disappear silently when they exit.

### Changed

- The session broker keeps a bounded VT model of each terminal's screen, scrollback, modes, cursor,
  and alternate-screen state together with a short sequenced output ring.
- Existing renderers resume from their last parser-committed byte. New or lagging renderers receive
  only the missing output or a compact snapshot, including recovery in place on the same WebSocket.
- Foreground activity follows process groups, so pipelines remain one command when their leading
  process exits. Agent activity continues to take precedence over ordinary commands.
- One focused browser responds to live terminal device queries when several clients are attached.

### Fixed

- Reconnecting to a long session no longer requires streaming its complete retained history.
- Full-screen TUIs restore their canonical alternate-screen state instead of depending on a raw
  output replay that can corrupt or terminate the application.
- Browser-initiated protocol and timeout closes now use valid WebSocket application close codes.
- Docker release builds include the embedded agent integrations and artifact skill required by the
  Rust build.
- A `0.5.1` in-app update now replaces its incompatible protocol-2 session broker automatically
  instead of leaving the new web process unable to start.

### Security

- Snapshot application suppresses terminal-generated replies, so historical device queries are not
  written back into the live PTY.
- Interpreted scripts are labeled from their basename without exposing script arguments or inline
  command text in command status and notifications.

### Upgrade notes

- This release upgrades the private session broker protocol from 2 to 3. Updating from `0.5.1`
  automatically restarts the broker and closes existing terminals. Let long-running terminal work
  finish before installing the update.
- There are no data migrations or configuration changes.
- The release is safe for automatic installation over `0.5.1`; an incompatible broker is replaced
  and the web process reconnects to the new broker automatically.

## 0.5.1 - 2026-07-26

Term-server now owns, updates, and reports the artifact skill used by Codex, Claude Code, and Pi.

### Added

- Settings → Artifact skill reports whether each agent uses term-server's bundled skill, a matching
  external copy, an outdated copy, a broken link, or no skill.
- Per-agent actions can install the bundled skill, adopt it in place of an external symlink, or
  remove a link managed by term-server.

### Changed

- The canonical artifact skill is embedded in the term-server binary and repaired into the installed
  release bundle on startup.
- Signed automatic updates now validate and replace the bundled `skills/` directory together with
  the browser client and binary, including rollback on installation failures.
- Artifact skill instructions now tell Codex, Claude Code, and Pi to record their own provider name
  instead of hard-coding Codex.

### Fixed

- Upgrading with the 0.5.0 automatic updater no longer leaves the original artifact helper behind.
  The 0.5.1 binary repairs that bootstrap case on its first startup.
- External artifact skill copies are identified in Settings instead of silently shadowing the
  bundled version and drifting out of sync.

### Security

- Artifact skill status requires authentication, and install, repair, and removal require both
  authentication and a same-origin request.
- Repair can replace only a symlink. Standalone files and directories are never overwritten, and
  removal refuses to touch links not owned by term-server.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- If Settings reports an external or outdated artifact skill, choose **Use bundled skill** and start
  a new agent session. Standalone directories must be moved aside manually before adoption.
- The separate `my-skills` repository no longer distributes `term-server-artifacts`; term-server is
  its single source of truth.
- The release is safe for automatic installation over `0.5.0`.

## 0.5.0 - 2026-07-25

Live agent activity no longer delays Codex or Claude Code when tools return large payloads or the
private session broker is slow.

### Changed

- Managed Codex and Claude Code hooks detach lifecycle event forwarding from the provider's
  synchronous hook command while continuing to consume its input.
- Broker event delivery now stops after 500 milliseconds if the private session broker does not
  respond.

### Fixed

- Oversized hook payloads are fully drained before the helper exits, preventing broken pipe errors
  after image previews and other tools with large results.
- Detached hook forwarding retains its input pipe until the provider finishes writing, so broker
  latency does not hold up the agent loop.

### Security

- The 1 MiB parsing limit remains enforced. Oversized payloads are discarded without parsing or
  forwarding prompts, tool arguments, or tool output to the session broker.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- After upgrading, repair installed Codex or Claude Code packages from Settings → Live agent
  activity. Codex will ask you to review the changed hook through `/hooks`; start a new agent
  session after repairing either package.
- The Pi integration is unchanged.
- The release is safe for automatic installation over `0.4.1`.

## 0.4.1 - 2026-07-24

Pi-generated terminal titles now describe the agent's initial task instead of terminal setup traffic.

### Fixed

- Prompt capture now discards OSC and other terminal control-string replies, including xterm
  foreground and background color responses, rather than sending them to Pi as the initial user
  message.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Restart the session broker from Settings after upgrading so new terminals use the corrected
  prompt capture. Restarting the broker closes open terminals and requires confirmation when any
  are running.
- The release is safe for automatic installation over `0.4.0`.

## 0.4.0 - 2026-07-24

Term-server can now receive privacy-bounded lifecycle events directly from Codex, Claude Code, and
Pi while keeping its existing process, output, CPU, terminal-signal, and OSC inference.

### Added

- Settings → Live agent activity can install, repair, and remove a dedicated local plugin or
  extension for Codex, Claude Code, and Pi.
- The terminal sidebar shows transient native activity such as thinking, running a command, editing
  files, searching, waiting for approval, and compacting context.

### Changed

- Native events feed the existing working, idle, and closed state machine and completion
  notifications instead of creating a separate status system.
- Existing inference remains enabled at all times. If a native update goes stale or a hook fails,
  term-server automatically returns control to its heuristic detection.
- Managed integrations use their own package roots and local marketplaces. Install, repair, and
  removal do not edit existing provider hook files.

### Security

- Hook payloads are reduced to fixed activity categories before they reach the private session
  broker. Prompts, command text, tool arguments, and tool output are not forwarded.
- Managed hooks do nothing outside a term-server terminal, verify exact marketplace ownership, and
  refuse to claim a conflicting marketplace name.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Native integrations are optional. Existing agent detection continues to work before installation,
  after removal, or when a provider is unavailable.
- Restart the session broker from Settings after upgrading so new terminals receive the native hook
  environment. Restarting the broker closes open terminals and requires confirmation when any are
  running.
- Codex requires a one-time review of the installed hooks through `/hooks`. Start a new agent session
  after installing or changing any provider package.
- The release is safe for automatic installation over `0.3.3`.

## 0.3.3 - 2026-07-24

The login page can now reset stale browser state when Safari or an installed app keeps loading an old client.

### Added

- A confirmed “Clear cache and site data” action on the login page signs out the current browser, removes saved term-server settings, deletes Cache Storage entries, unregisters service workers, and reloads from a cache-busting URL.
- The reset response asks supported browsers to clear HTTP caches and origin storage, covering storage that the client does not use directly.

### Security

- The reset endpoint is available before authentication because it only removes data from the requesting browser. Cross-origin requests are rejected, and server-side terminal sessions keep running.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Clearing site data removes browser-only preferences and the current sign-in cookie. Password-manager entries and server-side terminal sessions are not removed.
- The release is safe for automatic installation over `0.3.2`.

## 0.3.2 - 2026-07-24

Session broker updates are now visible and can be activated from Settings without manually restarting the service.

### Added

- Settings → Updates reports when the persistent session broker is older than the web server, including both build versions and the number of open terminals.
- An authenticated restart action activates the current broker build and reconnects the browser automatically.

### Fixed

- Broker-side fixes no longer remain silently unavailable after an in-process update preserves an older compatible broker.
- Broker restarts wait for the old Unix socket to disappear before the web process starts again, avoiding a reconnect to the broker being replaced.

### Security

- Restart requests require authentication and same-origin validation. The server requires explicit acknowledgement before it will close open terminals.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Normal automatic updates still preserve running terminals. If Settings reports a broker mismatch, restarting it with open terminals requires confirmation and closes those terminals.
- The release is safe for automatic installation over `0.3.1`.

## 0.3.1 - 2026-07-24

Installed apps now stay aligned with the running server, sign-in lasts across normal browser use, and fast agent tasks reliably produce completion notifications.

### Added

- Installed apps use the server hostname in their display name, which makes multiple term-server installations easier to distinguish.
- Successful logins offer credentials to supported browser password managers.

### Fixed

- Installed PWAs no longer keep an old application shell after a server update. The replacement service worker removes the legacy Workbox cache, takes control immediately, and reloads affected installed clients once.
- Agent tasks submitted before the first 1.5-second process discovery sample now produce completion notifications, summaries, and attention state. Starting an agent without a task remains silent.

### Changed

- Successful logins create revocable 400-day sessions instead of seven-day sessions.
- Authenticated API responses are marked `no-store`; the application entry point and generated web manifest are revalidated, and install icons include the build revision.
- PWA navigation is network-only because terminals, files, and authentication already require the running daemon.

### Security

- Longer sessions remain protected by HTTP-only, SameSite cookies and are still revoked by explicit logout or password changes.
- Authenticated API responses are explicitly non-cacheable to avoid retaining session data in browser caches.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Older installed PWAs automatically remove their legacy application cache and may reload once during the upgrade.
- The release is safe for automatic installation over `0.3.0`.

## 0.3.0 - 2026-07-23

Terminal and artifact management now cover the common cleanup and inspection workflows directly from the workspace, with better mobile sizing and more useful completion notifications.

### Added

- Terminal kill actions in the left sidebar, with a setting to skip confirmation when immediate termination is preferred.
- Permanent artifact deletion from the terminal sidebar and full editor, including confirmation when an open artifact has unsaved changes.
- Complete descendant process discovery with live CPU and resident-memory usage, plus confirmed process termination from the inspector.
- Mobile terminal zoom controls in the touch keybar. The selected font size is remembered in the browser and the percentage button resets it to the default.
- Notification placement and dismissal settings, including four screen corners, timed dismissal, and a keep-open option.

### Fixed

- Starting Codex, Pi, or another supported agent no longer treats terminal initialization and color queries as completed work. Empty starts do not request a Pi summary, change attention state, or send a completion notification.
- Process inspection now includes descendants that are not direct children of the terminal shell.

### Changed

- Completion notifications now default to the top-right corner and use the originating terminal color for their border, accent, icon, and surface tint.
- Artifact deletion updates open tabs, inline previews, and workspace counts immediately.

### Security

- Process termination revalidates terminal ancestry, process start time, and PID identity before sending `SIGTERM`.
- Artifact deletion remains authenticated and origin-checked, accepts only scoped artifact identifiers, and refuses to follow artifact-directory symlinks.
- Development guidance now requires an isolated `TERM_SERVER_DATA_DIR` so test servers cannot attach to or stop the production session broker.

### Upgrade notes

- There are no breaking changes, data migrations, or broker protocol changes.
- Existing notification preferences remain compatible. New placement defaults to top-right and new dismissal behavior defaults to seven seconds.
- Existing artifacts remain compatible and can be deleted after upgrading.
- The release is safe for automatic installation over `0.2.0`.

## 0.2.0 - 2026-07-23

Artifacts now stay connected to the terminal and agent that created them instead of behaving like files that must remain open.

### Added

- A per-terminal artifact sidebar with inline text, image, and PDF previews, copy and download actions, and an explicit full-editor action.
- Artifact counts in workspace rows and terminal headers, plus navigation from a full artifact editor back to its originating agent.
- Stable creation timestamps and validated producer metadata for new artifacts, so their exact origin survives later terminal reuse.

### Fixed

- Closing an artifact editor tab now remains closed. Artifact polling updates the inventory and open documents independently, so it cannot reopen a dismissed tab.
- Closing the inline sidebar remains the user's choice; only a genuinely new artifact opens it again.
- Artifact discovery now ignores incomplete staging directories and ambiguous payloads. The helper publishes a complete artifact atomically.

### Changed

- Existing artifacts are discovered as session inventory items and opened in full tabs only on request.
- The bundled `term-server-artifacts` skill records `codex` as the producer while keeping artifacts from older skill versions compatible.

### Security

- No security behavior or trust boundary changed in this release.

### Upgrade notes

- There are no breaking changes or data migrations.
- Existing temporary artifacts remain compatible. New producer metadata is added only to artifacts created after upgrading.
- The release is safe for automatic installation over `0.1.1`.

## 0.1.1 - 2026-07-23

First automated release of term-server.

### Added

- A secure browser terminal workspace with persistent PTYs, multi-pane layouts, directory-aware workspaces, file editing, process inspection, agent status, notifications, and an installable PWA.
- Signed self-updates for eligible Linux installations. Release manifests, checksums, archive size, target architecture, safe extraction paths, and the replacement binary identity are verified before installation.
- A private session broker that preserves active terminals and replay history while the HTTPS process updates and restarts.
- Session-scoped editable artifacts for handing multiline messages, prompts, snippets, and images between coding agents and the browser.
- Native PDF previews, byte-range streaming, and direct downloads for text, image, and PDF files.
- Mobile terminal scrollback, a terminal key strip, one-shot Ctrl and Alt modifiers, safe-area support, and live visual viewport sizing.
- Shared terminal sizing across connected devices, with smallest-client sizing by default and an optional focused-device controller.
- Embedded version and source commit details in the CLI, authenticated API, Settings, and status bar.

### Changed

- Mobile terminal gestures now scroll xterm history without moving the browser viewport.
- The internal session broker protocol is version 2 so terminal sizing and focus state pass through the broker consistently.
- Pi chat titles now stay anchored to the initial task instead of changing during follow-up work.

### Security

- Release manifests and checksum lists are authenticated with Ed25519 signatures from the repository release key.
- Update installation fails closed on missing or invalid signatures, unexpected platforms, size or checksum mismatches, unsafe archive entries, or mismatched binary identity.
- Update checks and installation remain authenticated, origin-checked operations.

### Upgrade notes

- There is no data migration.
- Existing `0.1.0` or earlier installations do not yet have the automatic updater. Rerun the installer to receive this release; eligible installations can use signed automatic updates afterward.
- Development builds using broker protocol 1 cannot hand active sessions to protocol 2. Stop the old term-server and its session broker before starting this release.
