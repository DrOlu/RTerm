# <img src="./demo_imgs/icon.png" width="40" height="40" align="center" style="margin-right: 10px;"> GyShell

> **The AI-Native Terminal that thinks, executes, and collaborates with you.**

[![License](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#platforms)
[![Shell](https://img.shields.io/badge/Shell-Zsh%20%7C%20Bash%20%7C%20PowerShell-orange)](#key-capabilities)

English README | [中文 README](./README.zh-CN.md)  
Latest release notes: [`changelogs/v1.0.0.md`](./changelogs/v1.0.0.md)
Usage guides:
[`docs/mobile-web-usage.md`](./docs/mobile-web-usage.md) ·
[`docs/tui-usage.md`](./docs/tui-usage.md) ·
[`docs/gybackend-usage.md`](./docs/gybackend-usage.md)

> [!TIP]
> **Recommended Models**:
> - **Cost-Performance**: Thinking-GLM 5 + Action/Global: Minimax2.5
> - **Best Performance**: Thinking-Gemini 3.1 Pro + Action/Global: Gemini 3 Flash
> - **Local (Mac Studio)**: All-Qwen3.5 / Minimax2.5

> [!WARNING]
> **Active Development**: GyShell evolves quickly. If a version introduces history compatibility breaks, it will be called out explicitly in release notes.

<p align="center">
  <img src="./demo_imgs/demo.png" width="100%">
</p>
<p align="center">
  <video controls width="100%" src="https://github.com/user-attachments/assets/f9daf884-bda0-4a58-8a6d-934db0eddeb5"></video>
</p>

---

## Why GyShell Is Different

Most AI terminal tools either generate one-shot scripts, or run in isolated sandboxes detached from real shell workflows.

GyShell is built for **persistent execution in your real terminal runtime**:

- **Persistent execution loop**: observe output -> reason -> continue.
- **Human-in-the-loop by design**: intervene anytime without breaking flow.
- **Multi-tab orchestration**: compile, inspect logs, and run fixes in parallel tabs.
- **OpenClawd-style remote conversation control**: keep the runtime core on your own computer and steer it from anywhere through chat.
- **Cross-surface runtime model**: desktop, TUI, and mobile-web share one gateway semantics.
- **Profile lock safety**: busy sessions pin active model profile for consistency.
- **Tooling-native workflow**: skills, MCP servers, and built-in tools are runtime primitives.

### At a Glance

- **For shipping work**: not just planning, but iterative execution and correction.
- **For long-running tasks**: preserves session continuity and state across steps.
- **For real infrastructure**: shell, SSH, forwarding, and multi-tab interactive terminal control.
- **For multi-device flow**: desktop + TUI + mobile-web with shared gateway semantics.

## v1.0.0 Key Highlights

- **Refined chat-first TUI**
  - cleaner layout and scanability
  - clearer run-state feedback
  - smoother input behavior for long sessions
- **Desktop-bundled `gyll` CLI**
  - auto-connect local desktop backend when `--url` is omitted
  - supports interactive, streaming, and hook callback modes
- **Practical mobile-web upgrade**
  - session browser + search + run-state indicators
  - message detail sheet for turn-level deep inspection
  - tools panel for MCP/built-in tool enablement
- **Runtime stability improvements**
  - synchronized lifecycle events (`SESSION_PROFILE_LOCKED`, `SESSION_READY`)
  - terminal tab operations aligned across transports
- **MCP stdio startup hardening**
  - stronger PATH merge strategy
  - deterministic CWD fallback behavior

---

## Key Capabilities

### AI-Native Runtime

- Thinking-oriented execution for complex tasks.
- Context-aware responses from terminal state and selected resources.
- Long-session token management with focused context retention.
- OpenAI-compatible model endpoint support.

### Terminal + SSH

- Shell support: Zsh, Bash, PowerShell.
- SSH support: password/key auth, proxy chaining, bastion workflows.
- Port forwarding: local, remote, and dynamic SOCKS.
- Agent can coordinate **multiple SSH/local terminal tabs** in parallel during one task.
- Control-character operations for interactive terminal apps.

### Skills + MCP + Tools

- Folder-based skills workflow compatible with agentskills-style structure.
- Dynamic MCP server integration.
- Precision editing tools for safe, targeted file updates.
- Runtime tool toggles and summaries exposed to clients.

### Mobile-Web Companion

- Mobile-first remote client for active session tracking and steering.
- OpenClawd-style conversational control from anywhere while your core runtime stays on your own machine.
- Session list with search and status hints.
- Detailed turn event inspection from phone browser.
- Tool/skill/terminal/settings access through gateway RPC.

---

## Platforms

1. **Electron desktop app** (`apps/electron`)
2. **Standalone backend runtime** (`apps/gybackend`)
3. **TUI runtime** (`apps/tui` wrapper + `packages/tui` core)
4. **Mobile-web runtime** (`apps/mobile-web` wrapper + `packages/mobile-web` core)

### Which Surface Should You Use?

- **Desktop app**: primary full-featured experience for daily development.
- **TUI (`gyll`)**: terminal-native flow for keyboard-first sessions and automation, including multi-tab command orchestration.
- **Mobile-web**: OpenClawd-style remote conversational control from phone/browser.

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Development

```bash
git clone https://github.com/MrOrangeJJ/GyShell.git
cd GyShell
npm install
npm run dev
```

### First-run CLI experience

After desktop installation and first launch:

```bash
gyll --help
gyll "Plan and execute: run tests, fix failures, and summarize changes"
```

### One-line Mental Model

`GyShell = persistent AI runtime + real terminal control + human override at any time.`

### Mobile-web development

```bash
npm run dev:mobile-web
```

### TUI development

```bash
npm run dev:tui
```

---

## Desktop Bundled CLI (`gyll`)

After installing and launching GyShell desktop once, `gyll` is available from the desktop runtime setup.

If `--url` is not provided, CLI will try the local desktop backend (`127.0.0.1:17888` by default).

```bash
gyll --help
gyll --url ip:port
gyll --url ip:port "Hello"
gyll run --url ip:port "Run task"
gyll hook --url ip:port "Send and exit"
```

Local quick forms:

```bash
gyll
gyll "Hello"
gyll run "Run task"
gyll hook "Send and exit"
```

Modes:

- `gyll`: interactive TUI.
- `gyll "message"`: create session, send immediately, then enter TUI.
- `gyll run "message"`: create session, stream output in terminal, no TUI entry.
- `gyll hook "message"`: create session, send once, then exit.

You can also resume a target session:

```bash
gyll --sessionid "your-session-id"
```

Hook mode is useful for callback-style self-wakeup in long workflows.

### Typical `gyll` patterns

- **Interactive pairing**: `gyll`
- **Single prompt then continue in TUI**: `gyll "message"`
- **Automation-like terminal streaming**: `gyll run "message"`
- **Callback signal / wake-up message**: `gyll hook "message"`

---

## Architecture Notes

GyShell follows strict layering:

- `packages/*`: implementation logic.
- `apps/*`: composition/bootstrap/build wrappers.
- Frontend logic does not belong in `packages/backend`.

Core runtime chain (simplified):

1. `startElectronMain` (desktop composition root)
2. `GatewayService` (session runtime + transport-agnostic orchestration)
3. `WebSocketGatewayControlService` (policy-based ws gateway control)
4. `WebSocketGatewayAdapter` / `ElectronWindowTransport` (transport implementations)
5. Client controllers in TUI and mobile-web

See:

- `docs/monorepo-architecture.md`
- `docs/build-commands.md`

## Privacy and Update Policy

- Version checks query only this repository's GitHub `version.json`.
- No third-party auto-update endpoint is used.
- Version check is the only automatic background network request.

## Read More

- Release notes: `changelogs/v1.0.0.md`
- Build matrix and packaging: `docs/build-commands.md`
- Monorepo boundaries and runtime flow: `docs/monorepo-architecture.md`

---

## Build and Packaging

- `npm run build`
- `npm run build:backend`
- `npm run build:tui`
- `npm run build:mobile-web`
- `npm run dist`
- `npm run dist:mac`
- `npm run dist:win`

For the full command matrix and packaging notes, see `docs/build-commands.md`.

---

## License

This project is licensed under **CC BY-NC 4.0**.

Special acknowledgment: inspirations and references from [Tabby](https://github.com/Eugeny/tabby) (MIT).

---

**GyShell** - *The shell that thinks with you.*
