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

Pi terminal intelligence is disabled by default. Enabling it sends a bounded, ANSI-sanitized tail of terminal output to the selected Pi model provider; that output may contain source code, command output, paths, or secrets. Use only a provider appropriate for that data. term-server starts Pi without project context, sessions, skills, or built-in tools and exposes only a single metadata-result tool, but model-provider data handling remains governed by the selected provider.

## Reporting a vulnerability

Please report vulnerabilities privately to the project maintainers. Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not open a public issue until a fix or disclosure plan is available.
