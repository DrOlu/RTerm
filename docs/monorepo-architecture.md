# GyShell Monorepo Architecture

This repository now uses clear runtime/package separation.

## Runtime Shapes

1. Electron desktop app (`apps/electron`)  
2. Standalone backend service (`apps/gybackend`)  
3. Standalone TUI client (`apps/tui`)

## Workspace Layout

```text
GyShell/
├── apps/
│   ├── electron/           # Electron shell (main/preload/config/sign scripts)
│   ├── gybackend/          # Standalone backend bootstrap
│   └── tui/                # Standalone TUI frontend
├── packages/
│   ├── backend/            # Single-source backend logic (services + adapters + types)
│   ├── ui/                 # Shared web UI package
│   └── shared/             # Cross-runtime contracts (future expansion)
├── package.json            # Workspace orchestrator scripts
└── turbo.json              # Task graph scaffold
```

## Ownership Boundaries

- `packages/backend`
  - Agent, gateway, terminal/runtime services
  - Command policy / skills / MCP runtime and adapters
  - Backend domain types and runtime contracts
- `packages/ui`
  - Renderer React app and shared theme modules
- `apps/electron`
  - Composition root (`apps/electron/src/main/index.ts`)
  - Preload bridge (`apps/electron/src/preload/*`)
  - Platform window behavior (`apps/electron/src/main/platform/*`)
  - Electron build/package config (`apps/electron/electron.vite.config.ts`, `apps/electron/electron-builder.yml`)
  - macOS signature workaround script (`apps/electron/scripts/fix-mac-signatures.sh`)
- `apps/gybackend`
  - Node process bootstrap and runtime wiring only
- `apps/tui`
  - Chat-first websocket client runtime

## Packaging/Signing Constraint

`dist:mac` keeps the existing signature workaround chain unchanged in behavior:

- `electron-builder --mac --dir`
- `apps/electron/scripts/fix-mac-signatures.sh`
- `electron-builder --mac --prepackaged ...`

This preserves the previous macOS packaging behavior while moving configuration ownership into `apps/electron`.

## Next Milestones

- Move more protocol contracts from `packages/backend` into `packages/shared`
- Add package-level unit tests for `packages/backend` and `packages/ui`
- Keep `apps/*` as thin shells with zero business logic duplication
