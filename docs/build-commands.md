# Build Commands

## Root (`package.json`)

- `npm run dev`
  - Electron dev mode using `apps/electron/electron.vite.config.ts`.
- `npm run build`
  - Electron build using `apps/electron/electron.vite.config.ts`.
- `npm run build:backend`
  - Build standalone backend workspace `@gyshell/gybackend`.
- `npm run build:tui`
  - Build standalone TUI workspace `@gyshell/tui`.
- `npm run build:all`
  - Build Electron + backend + TUI.
- `npm run typecheck:all`
  - Typecheck Electron node/web + backend + TUI.
- `npm run test:backend-regression`
  - Backend regression test suite.
- `npm run test:backend-extreme`
  - Backend extreme-path test suite.

## Dist / Packaging

- `npm run dist`
  - Build backend + Electron, then package via `apps/electron/electron-builder.yml`.
- `npm run dist:mac`
  - Build backend + Electron, then run macOS packaging flow:
  1. `electron-builder --mac --dir`
  2. `apps/electron/scripts/fix-mac-signatures.sh`
  3. `electron-builder --mac --prepackaged ...`
- `npm run dist:win`
  - Build backend + Electron, package Windows targets.

## Workspace Commands

- `npm --workspace @gyshell/gybackend run build|start|typecheck`
- `npm --workspace @gyshell/tui run build|dev|start|typecheck|test:smoke`
- `npm --workspace @gyshell/backend run build|typecheck`
- `npm --workspace @gyshell/ui run build|typecheck`
- `npm --workspace @gyshell/shared run build|typecheck`
