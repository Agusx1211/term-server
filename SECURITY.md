# Security policy

term-server exposes an interactive shell with all permissions of the operating-system user that runs it. Treat access to the web application as equivalent to SSH access for that user.

## Deployment baseline

- Keep HTTPS enabled or terminate TLS at a trusted reverse proxy on the same host/private network.
- Use a unique, randomly generated password and protect the password file/environment.
- Bind to loopback unless remote access is intentional.
- Run term-server as a dedicated, unprivileged user with only the filesystem access its terminals require.
- Keep the Rust binary, browser dependencies, base image, and reverse proxy updated.
- Add public-network controls such as VPN access, firewall rules, and proxy-level rate limits where appropriate.

Generated credentials and private keys are written with owner-only permissions on Unix. Cookies are HTTP-only and SameSite=Strict; Secure is added whenever built-in HTTPS is enabled. Mutating requests and WebSocket upgrades enforce same-origin checks.

Official update metadata and checksum lists are signed with Ed25519. Installed releases verify the embedded public key before parsing release metadata, then verify the selected archive's signed size and SHA-256 checksum and the extracted binary's version and commit before installation. A checksum without a valid signature is not trusted.

The rolling `main` and `beta` channels use the same signature and package verification. Changing channels requires an authenticated same-origin request and is persisted owner-only. Beta changes release cadence, not the trust model: it follows `dev` and may contain code that has not reached the release branch.

Pi-generated titles and notification summaries are independently disabled by default. Enabling titles sends a bounded copy of the submitted task message to the selected Pi model provider. Enabling notification summaries sends a bounded, ANSI-sanitized tail of terminal output, which may contain source code, command output, paths, or secrets. Use only a provider appropriate for that data. term-server starts Pi without project context, sessions, skills, or built-in tools and exposes only a single metadata-result tool, but model-provider data handling remains governed by the selected provider.

## Supervisor terminal boundary

The supervisor capability is a product-level boundary between terminal roles, not an operating-system sandbox. Only the singleton supervisor shell receives its control token, private socket path, skill, and PATH entry; the server stores only a token hash and rejects calls after that terminal exits or is killed. Control requests, browser-view snapshots, and responses are size-bounded, and generated supervisor files refuse symlinked managed directories.

Full terminal scrollback and semantic agent transcripts are sensitive retained session data. They are reachable only through the supervisor control request path: the server validates the supervisor terminal ID and capability before querying the owning session broker, which independently requires a private broker-control token that terminal children never inherit. Regular terminal environments receive neither capability nor the supervisor CLI path. The Supervisor exposes no MCP server or provider-specific tool adapter; all operations use the capability-checked CLI. Transcript records are size-bounded and retained only with the terminal session, but may contain user messages, tool arguments, command output, and model responses; treat exported text or JSONL accordingly.

Every terminal still runs as the same operating-system user. A deliberately hostile same-UID process may be able to inspect another process through `/proc`, ptrace it, access its PTY, or otherwise recover inherited environment values. Preventing that requires separate Unix identities or sandboxing terminal processes, which term-server does not provide. Do not use the supervisor feature as a security boundary between mutually untrusted agents.

Terminal screens and process output returned to a supervisor agent are untrusted content and can contain prompt-injection text. The embedded skill tells agents to treat that content as data, but model behavior is not an enforcement mechanism. Review destructive requests and keep normal provider approval policies enabled.

## Terminal access control boundary

Secret and sudo requests are bound to a terminal UUID and a live Linux descendant process identity
(`pid:start_ticks`). Agent lifecycle hooks and screen detection remain advisory and cannot approve a
request. Browser decisions require authentication, an explicit same-origin header, HTTPS (or the
configured trusted TLS reverse proxy), and the hash of the immutable request currently displayed.

Secret values are held only in the owning session broker's memory and are zeroized on drop on a
best-effort basis. API snapshots expose names and bounded use metadata, never values. A secret
command is started by the broker with an allowlisted environment plus the one approved delivery
variable, or with the value on standard input when explicitly requested; the agent process never
receives the value. The streaming redactor replaces raw values and bounded common Base64, Base32,
hex, percent, escaped octal/hex/Unicode, binary, SHA-256, and SHA-512 forms across stdout/stderr and
chunk boundaries with a marker naming the grant. Derived variants are enabled only for 4–1024-byte
secrets to bound memory and false positives. Arbitrary transformations, encryption, compression,
partial output, and unrecognized encodings cannot be reliably detected.
Canceling the requester or closing its terminal kills the broker-started process group. This is not a sandbox: a hostile
same-UID command can deliberately create a new session or process group and escape that cleanup.

Sudo approvals cover one stored argument vector and working directory; no shell is added. The broker
requires a root-owned executable that is not group- or world-writable, canonicalizes it, and commits
its content hash and filesystem identity plus the working-directory identity to the request
fingerprint, then rechecks them immediately before invoking the target through `sudo`. Arguments may
still name mutable scripts, packages, configuration, or other inputs; the user must review those
effects.

The browser password field is cleared before the request completes. The broker sends the password
only to `sudo` standard input, never to command arguments, the command environment, terminal output,
transcripts, logs, browser storage, or a reusable secret grant, and best-effort zeroes its Rust
buffers immediately after delivery. Sudo authentication timestamps are removed immediately after
validation and again after execution. A root command that has already been approved may continue if
the requesting agent disconnects or its terminal closes.

These controls prevent accidental disclosure through term-server interfaces; they do not create an
isolation boundary against hostile same-UID code. Such a process may inspect memory, trace another
process, read the owner-only broker token, or interfere with the local runtime under the operating
system threat model described above. Use separate Unix users or a sandbox for mutually untrusted
agents, and do not expose term-server on an untrusted network.

## Optional provider status modules

The optional status configuration is version-1 non-secret TOML selected with
`--status-config` or `TERM_SERVER_STATUS_CONFIG`. Keep the file owner-readable
because module labels and admin project/workspace identifiers can still be
operationally sensitive, but never put a key, token, bearer value, or password
in it. Unknown keys and unsupported provider fields are rejected at startup.

Provider credentials are discovered once from the term-server startup
environment. On Unix, the same-user session broker and terminal children
intentionally inherit these variables, so commands run by that user may observe
them. They are never accepted from the browser, copied into the status
configuration, serialized in `/api/status-modules`, or written to logs. The
endpoint is authenticated and no-store. The browser receives only bounded
provider-neutral display values, fixed error codes/messages, and timestamps; it
never receives an authorization header, upstream response body, raw URL,
account identifier, or credential name/value.

Normal `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and
`ZAI_API_KEY` values are used only to report configured state. The status
service does not make model calls or paid inference requests just to discover
rate-limit headers.

`OPENAI_ADMIN_KEY` and `ANTHROPIC_ADMIN_KEY` are separate admin credentials:
they are used only by a module with explicit `admin = true` and the matching
provider, never as a fallback for a normal module. Admin modules query only the
documented provider rate-limit endpoints; configured limits are not billing
balances or remaining quota. Anthropic workspace responses are overrides only:
omitted or null limit types inherit organization settings and are never
presented as complete effective limits.

Missing credentials produce an unconfigured module without network access.
Provider failures are isolated and normalized to safe fixed messages. A refresh
uses at most eight upstream requests concurrently and has a 60-second aggregate
deadline; retryable failures use bounded exponential backoff. After a
successful snapshot, a failed refresh retains the prior display value but marks
the module warning/stale and exposes only a retryable sanitized error; an
initial failure has no prior value to retain. Custom outbound URLs, dashboard
scraping, undocumented provider endpoints, and browser-supplied credential
paths are not supported.

## Reporting a vulnerability

Please report vulnerabilities privately to the project maintainers. Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not open a public issue until a fix or disclosure plan is available.
