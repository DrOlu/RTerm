# Build Commands

This file lists the current build-related commands in the repository.

## Root (`package.json`)

- `npm run build`
  - Build Electron app via `electron-vite build`.
- `npm run build:electron`
  - Same as `npm run build`.
- `npm run build:backend`
  - Build standalone backend workspace package `@gyshell/gybackend`.
- `npm run build:all`
  - Build Electron first, then backend.
- `npm run dist`
  - Build Electron and package with `electron-builder`.
- `npm run dist:mac`
  - macOS packaging flow with the existing signature workaround pipeline.
- `npm run dist:win`
  - Windows x64 packaging flow.

## Backend Workspace (`apps/gybackend`)

- `npm --workspace @gyshell/gybackend run build`
  - Bundle backend entry (`src/index.ts`) to `dist/index.js`.
- `npm --workspace @gyshell/gybackend run start`
  - Start backend from `dist/index.js`.
- `npm --workspace @gyshell/gybackend run typecheck`
  - Type-check backend workspace.

## TUI Placeholder Workspace (`apps/tui`)

- `npm --workspace @gyshell/tui run build`
  - Placeholder command (no real build output yet).
- `npm --workspace @gyshell/tui run typecheck`
  - Placeholder command.

## Shared Workspace (`packages/shared`)

- `npm --workspace @gyshell/shared run build`
  - Placeholder command (type-only package at current stage).

## Turborepo Tasks

`turbo.json` defines task graph metadata:

- `turbo run build`
- `turbo run typecheck`
- `turbo run dev`

At the current stage, the project’s primary build entrypoints are still the root npm scripts listed above.
