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

Use `--stdin` instead of `--env NAME` only when the target explicitly reads the credential from standard input. The client resolves the executable through the terminal's `PATH`, then the broker requires its canonical absolute path. The broker launches the command without shell interpretation, streams combined output, and redacts exact occurrences of the secret on a best-effort basis. It never returns the value to the agent.

Revoke a grant only when the user asks or the capability is intentionally retired:

```bash
"$TERM_SERVER_EXECUTABLE" access secret drop --name SERVICE_API_KEY --agent omp
```

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
