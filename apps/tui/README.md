# @gyshell/tui

Standalone terminal UI client for GyShell gateway.

## Features

- Chat-first TUI workflow (no terminal tab content rendering)
- Gateway websocket auto-discovery on localhost (`ws://127.0.0.1:17888`)
- Fallback manual endpoint prompt when local gateway is unavailable
- Startup session recovery picker (list recovered sessions and choose one to restore)
- Profile switching, session switching, and slash-command actions
- Compact tool-call rendering optimized for small terminal viewports

## Run

```bash
npm --workspace @gyshell/tui run start
```

## Dev mode

```bash
# Run directly from source with watch mode
npm --workspace @gyshell/tui run dev
```

This does not start backend automatically. Start Electron app or backend service manually.

## Smoke test

```bash
npm --workspace @gyshell/tui run test:smoke
```

## CLI options

- `--url ws://host:port`
- `--host 127.0.0.1 --port 17888`
- `--timeout 3000`

When `--url` is not provided, TUI probes localhost endpoints first, then prompts for manual input if no endpoint responds.
