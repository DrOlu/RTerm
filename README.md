# <img src="./demo_imgs/icon.png" width="40" height="40" align="center" style="margin-right: 10px;"> GyShell

> **The AI-Native Terminal that thinks, executes, and collaborates with you.**

[![License](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#platforms)
[![Shell](https://img.shields.io/badge/Shell-Zsh%20%7C%20Bash%20%7C%20PowerShell-orange)](#key-capabilities)

English README | [中文 README](./README.zh-CN.md)  
Latest release notes: [`changelogs/v1.5.2.md`](./changelogs/v1.5.2.md)

If you have any suggestions or questions, please feel free to submit them in [GitHub Discussions](https://github.com/MrOrangeJJ/GyShell/discussions).

Usage guides:
[`docs/mobile-web-usage.md`](./docs/mobile-web-usage.md) ·
[`docs/tui-usage.md`](./docs/tui-usage.md) ·
[`docs/gybackend-usage.md`](./docs/gybackend-usage.md)

> [!WARNING]
> **Active Development**: GyShell evolves quickly. If a version introduces history compatibility breaks, it will be called out explicitly in release notes.

> [!NOTE]
> **v1.4.0 upgrade note**: the first launch after upgrading from a pre-1.4.0 version may briefly block while GyShell migrates legacy JSON history into SQLite and writes timestamped backup files. v1.4.3 has no additional migration step.

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
- **Workspace persistence**: terminal tabs and panel layout can survive restarts and restore quickly.
- **Detachable multi-window workspace**: peel panels into sub-windows and move tabs or whole panels across windows.
- **Adaptive panel tab display**: keep full tab strips or switch to a compact selector for narrow panel headers.
- **Integrated file management**: browse, edit, copy, and transfer files across local and SSH sessions without leaving the workspace.
- **Live resource visibility**: inspect CPU, memory, disks, network, processes, sockets, and GPU from local or SSH sessions.
- **OpenClawd-style remote conversation control**: keep the runtime core on your own computer and steer it from anywhere through chat.
- **Built-in mobile-web delivery**: desktop can publish the mobile-web companion directly over your LAN with copyable access links.
- **Cross-surface runtime model**: desktop, TUI, and mobile-web share one gateway semantics.
- **Profile lock safety**: busy sessions pin active model profile for consistency.
- **Long-horizon context quality**: memory.md + compaction summary pipeline keeps long sessions useful.
- **Tooling-native workflow**: skills, MCP servers, and built-in tools are runtime primitives.

### At a Glance

- **For shipping work**: not just planning, but iterative execution and correction.
- **For long-running tasks**: preserves session continuity and state across steps.
- **For real infrastructure**: shell, SSH, forwarding, file management, and multi-tab interactive terminal control.
- **For multi-device flow**: desktop + TUI + mobile-web with shared gateway semantics.
- **For multimodal workflows**: text and image inputs can be combined in one execution turn.

## v1.5.2 Key Highlights

- **Prevent sleep while a session is running**
  - a new **Prevent Sleep While Running** setting keeps the computer awake whenever any chat session is actively running, so long autonomous tasks don't stall when you step away — the screen may still turn off, and the block releases automatically once all runs finish
- **Local terminals stay alive when their shell exits**
  - if a **local** terminal's shell process exits (you type `exit`, or it crashes), GyShell respawns a fresh shell in the same tab — preserving the tab, its title, and its size — instead of leaving a dead "exited" tab behind
- **Reconnect disconnected SSH terminals**
  - a disconnected (exited) **SSH** tab now offers a **Reconnect** action in its right-click menu that re-establishes the connection from the tab's saved SSH config, reusing the same tab
- **Experimental agent file transfer between terminal tabs**
  - two new **experimental, off-by-default** agent tools (`copy_between_tabs` / `read_file_transfer_status`) let the agent run **asynchronous, copy-only** file transfers between tabs on **different machines** and poll their progress; tasks appear in the **Transfer Tasks** panel with an **AGENT / USER** origin badge and a new **Scanning** phase
- **Clearer chat & terminal tab indicators**
  - chat tabs now show a green **"running" dot** while that session is busy (matching terminal tabs), and tab styling / close buttons were unified for a cleaner, subtler look across chat, terminal, and the compact tab selector
- **More resilient agent stream loop**
  - providers that finish with `tool_calls` but emit no actual tool-call payload (e.g. some GLM-compatible endpoints) no longer dead-end a turn — GyShell detects the malformed finish and retries once with a non-streaming request before giving up

---

## Key Capabilities

### AI-Native Runtime

- Thinking-oriented execution for complex tasks.
- Context-aware responses from terminal state and selected resources.
- Per-profile model routing for `Global`, `Thinking`, `Action`, and `Compaction` roles.
- Long-session context quality with dedicated compaction models and dynamic compaction summaries.
- SQLite-backed conversation history with automatic one-time migration from legacy JSON storage.
- AI-assisted terminal command drafting from recent tab context, with paste-before-run control.
- Background (nowait) commands automatically notify the agent on completion, so the agent can close the loop without polling.
- Classic or Seamless chat activity display, depending on how much inline tool detail you want.
- Persistent global memory injection via `memory.md`.
- Multimodal user input pipeline (text + images) for compatible models.
- OpenAI-compatible model endpoint support, with automatic recovery from malformed empty tool-call stream finishes.
- Optional experimental agent tools, including asynchronous cross-machine file transfer between terminal tabs with progress polling.

### Terminal + SSH + File Management

- Shell support: Zsh, Bash, PowerShell.
- Older Windows PowerShell environments now use more reliable sidecar-based command completion tracking for local and SSH sessions.
- SSH support: password/key auth, proxy chaining, bastion workflows.
- Port forwarding: local, remote, and dynamic SOCKS.
- Agent can coordinate **multiple SSH/local terminal tabs** in parallel during one task.
- Control-character operations for interactive terminal apps.
- Draft a command for the current terminal tab from recent visible output, then paste it back without auto-running it.
- Search within the active terminal buffer without leaving the panel.
- Terminal tab restoration after backend restart, plus lossless output catch-up for renderer remount/reconnect within the same backend runtime.
- Local terminal tabs auto-respawn their shell if it exits, so a local tab stays usable instead of going dead.
- Disconnected SSH tabs can be reconnected in place from the tab right-click menu using their saved connection config.
- **Integrated file browser panel**: browse, create, rename, delete, preview, sort, filter, and search files across local and SSH sessions.
- **Cross-session file transfer** (copy/move) with real-time progress, cancellation, and adaptive SFTP tuning.
- **Built-in file editor panel** for editing text files, plus inline preview of images (`png/jpg/gif/webp/bmp/ico/svg/avif`) and PDFs (with page navigation and zoom), all directly in the workspace.
- **File row right-click menu** with Copy / Cut / Paste / Rename / Delete and **Copy Full Path(s)** to the system clipboard.
- **Paste conflict resolution**: choose between **Overwrite** and **Keep Both** (auto-numbered names) when pasting into a folder with same-named items.

### Workspace + Monitoring

- Detach panels into dedicated sub-windows and move tabs or whole panels across windows.
- Optionally keep the computer awake while any chat session is running, with the system-sleep block released automatically when runs finish.
- Chat tabs show a running indicator while a session is busy, mirroring terminal tab runtime-state dots.
- Choose `Auto`, `Expanded`, or `Select` panel tab display modes based on how much header space your workspace has.
- `Ctrl/Cmd+F` opens a panel-local find bar in terminal, current chat, file browser, and file editor.
- Open a resource monitor panel for local and SSH terminals from the workspace rail.
- Monitor panel surfaces CPU, memory, disk, network, process, socket, and GPU telemetry when available.
- Monitor collection is shared across tabs that point at the same local or SSH target, with failover if the original source tab exits.
- Monitor polling can be paused or resumed per local/SSH source, with the preference kept across restarts.
- Compact monitor layouts now give GPU telemetry its own card with clearer VRAM usage details.

### Skills + MCP + Tools

- Folder-based skills workflow compatible with agentskills-style structure.
- Dynamic MCP server integration.
- Precision editing tools for safe, targeted file updates.
- Runtime tool toggles and summaries exposed to clients.

### Mobile-Web Companion

- Mobile-first remote client for active session tracking and steering.
- Desktop can serve the mobile-web companion directly and expose copyable access links from settings.
- OpenClawd-style conversational control from anywhere while your core runtime stays on your own machine.
- Session list with search and status hints.
- Swipe-to-delete session flow for faster mobile cleanup.
- Detailed turn event inspection from phone browser.
- Tool/skill/terminal/settings access through gateway RPC.
- Gateway exposure can now be limited to localhost, LAN-only, custom CIDR ranges, or all interfaces.

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
gyll --url ip:port --token <access_token>
gyll --url ip:port "Hello"
gyll --url ip:port --token <access_token> "Hello"
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

Use `--token <access_token>` when connecting to a non-local websocket gateway.

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

- Release notes: `changelogs/v1.5.2.md`
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
- `npm run dist:linux`
- `npm run dist:linux-arm64`
- `./build.sh --help`

For the full command matrix and packaging notes, see `docs/build-commands.md`.

---

## License

This project is licensed under **CC BY-NC 4.0**.

Special acknowledgment: inspirations and references from [Tabby](https://github.com/Eugeny/tabby) (MIT).

---

**GyShell** - _The shell that thinks with you._
