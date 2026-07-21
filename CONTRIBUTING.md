# Contributing

Thanks for improving term-server. Keep changes focused, include tests for behavior, and preserve the bounded-memory guarantees around terminal output.

Before submitting a change, run:

```bash
npm ci
npm run check
```

Rust code is formatted with `cargo fmt` and linted with Clippy. Browser code is type-checked with TypeScript and tested with Vitest. Security-sensitive changes to authentication, cookies, origins, TLS, PTY spawning, or WebSocket flow control should explain their threat model in the change description.
