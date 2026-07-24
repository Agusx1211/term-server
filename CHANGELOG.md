# Changelog

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
