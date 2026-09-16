---
name: term-server-access
description: Request terminal-scoped secrets or local sudo execution through term-server's user approval panel. Use for credentials, API keys, passwords, tokens, or commands that require sudo while running inside a term-server terminal.
---

# Term Server Access

Use the integrated access client through `"$TERM_SERVER_EXECUTABLE" access`. It works only inside the originating term-server terminal and binds every request or grant to that terminal. Never invoke `sudo` directly, ask for credentials in chat, print a secret, or pass a secret as a command argument.

## Secrets

Request a secret and wait for the user to approve it in the terminal's Access panel:

```bash
"$TERM_SERVER_EXECUTABLE" access secret request \
  --name SERVICE_API_KEY \
  --description "Exact purpose and scope" \
  --agent omp
```

Replace `omp` with `claude`, `codex`, `pi`, or `hermes`. A user may also proactively grant a secret from the panel. Discover available names without exposing values:

```bash
"$TERM_SERVER_EXECUTABLE" access secret list --agent omp
```

Run an exact argument vector with a grant injected by the broker:

```bash
"$TERM_SERVER_EXECUTABLE" access secret run \
  --name SERVICE_API_KEY \
  --env SERVICE_API_KEY \
  --agent omp \
  -- /usr/bin/command argument...
```

Use `--stdin` instead of `--env NAME` only when the target explicitly reads the credential from standard input. The client resolves the executable through the terminal's `PATH`, then the broker requires its canonical absolute path. The broker launches the command without shell interpretation and streams combined output. Raw values and bounded common Base64, Base32, hex, percent, escaped octal/hex/Unicode, binary, SHA-256, and SHA-512 forms are replaced with `[REDACTED: SECRET_NAME]` on a best-effort basis. It never returns the value to the agent.

Revoke a grant only when the user asks or the capability is intentionally retired:

```bash
"$TERM_SERVER_EXECUTABLE" access secret drop --name SERVICE_API_KEY --agent omp
```

## Generating and handing secrets to the user

When a task needs a new password, token, or key (a database role, a service account, an admin login), do not invent one yourself: have the broker generate it. The value is granted to this terminal for `secret run` and you never see it.

```bash
"$TERM_SERVER_EXECUTABLE" access secret generate \
  --name APP_DB_PASSWORD \
  --description "Password for the app's Postgres role" \
  --agent omp
```

Defaults are 32 characters from letters and digits. `--length N` accepts 8-256 and `--charset alnum|ascii|hex|digits` picks the alphabet (`ascii` adds shell-safe punctuation). An existing grant of the same name is an error unless you pass `--replace`, which also withdraws any unviewed share of the old value.

To give the user a value they need to keep (the password you just generated, an API token the broker holds), share the grant. The user gets a card in the terminal's Access panel and can reveal the value exactly once; the broker forgets its copy for the panel after that reveal, and the grant keeps working for `secret run`.

```bash
"$TERM_SERVER_EXECUTABLE" access secret share \
  --name APP_DB_PASSWORD \
  --description "Store this in your password manager; the app already uses it" \
  --agent omp
```

`generate --share` does both in one call. `share` waits for the user: it prints `viewed` and exits `0` when they revealed the value, prints `dismissed` or `expired` and exits `126` when they did not (shares expire after one hour), and exits `125` on broker or protocol failures. Pass `--no-wait` to print the share id and return immediately; the offer stays in the panel until the user acts or it expires. Check on it later with `share-status --id ID` (prints `pending`, `viewed`, `dismissed`, or `expired`; add `--wait` to block with the exit codes above) or `share-list`. The value is never printed by any of these commands. Tell the user in chat that a value is waiting in the Access panel, and never repeat or guess it.

## Sudo

Submit one exact local command without a leading `sudo`:

```bash
"$TERM_SERVER_EXECUTABLE" access sudo \
  --description "Exact local effect, scope, and reason" \
  --agent omp \
  -- /usr/bin/command argument...
```

The user reviews the immutable argument vector and enters their sudo password in term-server. The resolved executable must be root-owned and not group- or world-writable; use a trusted system shell explicitly when shell syntax is unavoidable. The password is used only for that command, never shared with the agent, and best-effort zeroed after delivery. The command receives closed standard input. A shell request such as `/bin/sh -lc '...'` must describe every operation and any mutable script or file it consumes.

Exit codes are the command's exit code after approval, `126` for rejection, and `125` for broker/protocol failures. Stopping a pending client cancels its waiter; a root command already approved may continue.
