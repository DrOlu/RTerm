# <img src="./demo_imgs/icon.png" width="40" height="40" align="center" style="margin-right: 10px;"> RTerm

> **The AI-Native Terminal that thinks, executes, and collaborates with you.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#platforms)
[![Shell](https://img.shields.io/badge/Shell-Zsh%20%7C%20Bash%20%7C%20PowerShell-orange)](#key-capabilities)

English README | [中文 README](./README.zh-CN.md)  
Latest release notes: [`changelogs/v1.6.0.md`](./changelogs/v1.6.0.md)

If you have any suggestions or questions, please feel free to submit them in [GitHub Discussions](https://github.com/MrOrangeJJ/RTerm/discussions).

Usage guides:
[`docs/mobile-web-usage.md`](./docs/mobile-web-usage.md) ·
[`docs/tui-usage.md`](./docs/tui-usage.md) ·
[`docs/gybackend-usage.md`](./docs/gybackend-usage.md)

> [!WARNING]
> **Active Development**: RTerm evolves quickly. If a version introduces history compatibility breaks, it will be called out explicitly in release notes.

> [!NOTE]
> **v1.4.0 upgrade note**: the first launch after upgrading from a pre-1.4.0 version may briefly block while RTerm migrates legacy JSON history into SQLite and writes timestamped backup files. v1.4.3 has no additional migration step.

<p align="center">
  <img src="./demo_imgs/v1.6.0_dark.png" width="100%" alt="GyShell dark theme demo">
</p>
<p align="center">
  <img src="./demo_imgs/v1.6.0_light.png" width="100%" alt="GyShell light theme demo">
</p>
<p align="center">
  <video controls width="100%" src="https://github.com/user-attachments/assets/f9daf884-bda0-4a58-8a6d-934db0eddeb5"></video>
</p>

---

## Why RTerm Is Different

Most AI terminal tools either generate one-shot scripts, or run in isolated sandboxes detached from real shell workflows.

RTerm is built for **persistent execution in your real terminal runtime**:

- **Persistent execution loop**: observe output -> reason -> continue.
- **Human-in-the-loop by design**: intervene anytime without breaking flow.
- **Multi-tab orchestration**: compile, inspect logs, and run fixes in parallel tabs.
- **Global tab inventory**: scan, reopen, drag, close, and create terminal/chat tabs from a dedicated list panel.
- **Workspace persistence**: terminal tabs, panel layout, and saved layout slots can survive restarts and restore quickly.
- **Detachable multi-window workspace**: peel panels into sub-windows and move tabs or whole panels across windows.
- **Adaptive panel tab display**: keep full tab strips or switch to a compact selector for narrow panel headers.
- **Reusable Agent setting profiles**: save and reapply complete operating profiles for models, tools, policies, memory, and workflow flags.
- **Cross-chat context handoff**: reference previous conversations from the composer with `Pass Chat` mentions instead of manually copying history.
- **Integrated file management**: browse, edit, copy, and transfer files across local and SSH sessions without leaving the workspace.
- **Live resource visibility**: inspect CPU, memory, disks, network, processes, sockets, and GPU from local or SSH sessions.
- **OpenClawd-style remote conversation control**: keep the runtime core on your own computer and steer it from anywhere through chat.
- **Built-in mobile-web delivery**: desktop can publish the mobile-web companion directly over your LAN with copyable access links.
- **Cross-surface runtime model**: desktop, TUI, and mobile-web share one gateway semantics.
- **Profile lock safety**: busy sessions pin active model profile for consistency.
- **Long-horizon context quality**: memory.md + compaction summaries + visible boundaries + deterministic fallback recovery keep long sessions understandable.
- **Tooling-native workflow**: skills, MCP servers, and built-in tools are runtime primitives.
- **Plugin system**: anyone can develop a custom plugin (agent tools, event triggers, dashboard panels) and have it auto-integrate on startup — 6 official plugins ship out of the box.
- **SRE observability pillar**: metrics ledger, golden signals, SLO/error budgets, uptime watchdogs, incident ledger with RCA + postmortems, anomaly detection, capacity forecasting, and a unified live dashboard.
- **APM + DEM + k8s/cloud infra**: OTLP distributed-trace store, Core Web Vitals (RUM), cluster health, and Windows ETW diagnostics.
- **Governance & audit**: hash-chained tamper-evident audit ledger with Merkle-tree evidence sealing, an AGT-style YAML policy engine (allow/deny/escalate), and a maker/checker review model that independently verifies the agent's output for correctness, completeness, safety, compliance, and accuracy.

### At a Glance

- **For shipping work**: not just planning, but iterative execution and correction.
- **For long-running tasks**: preserves session continuity and state across steps.
- **For real infrastructure**: shell, SSH, forwarding, file management, and multi-tab interactive terminal control.
- **For multi-device flow**: desktop + TUI + mobile-web with shared gateway semantics.
- **For multimodal workflows**: text and image inputs can be combined in one execution turn.

## Latest Highlights

**v2.7.x — Governance, plugins & the maker/checker model:**
- **Review model (maker/checker)** with a visible Settings UI — a second model independently verifies the action model's output (correctness, completeness, safety, compliance, accuracy); skipped when not configured for fast output.
- **AGT policy engine** — YAML policies (allow/deny/escalate) evaluated before every consequential action, with a built-in safe default policy.
- **Hash-chained audit ledger + Merkle evidence sealing** for tamper-evident, independently-verifiable audit trails.
- **Monitor diagnostics** — one-call answer to "why aren't stats displaying?" per terminal.

**v2.5–v2.6 — Plugin system + official plugin suite + APerf:**
- **Plugin system** — custom plugins (agent tools, triggers, dashboard panels) auto-integrate on startup; 6 official plugins ship out of the box (patch-manager, request-router, sop-assistant, iam-connector, fraudops, netdata-rterm).
- **AWS APerf deep-dive** — deploy aperf to any Linux host for deep performance profiling with agent RCA on the findings.

**v2.0–v2.4 — The SRE pillar + advanced automation:**
- **Full observability** — metrics ledger, golden signals, SLO/error budgets, uptime watchdogs, incident ledger (RCA + postmortems), anomaly detection, capacity forecasting, unified live dashboard.
- **APM/DEM/infra/ETW** — OTLP traces, Core Web Vitals, k8s/cloud health, Windows ETW diagnostics.
- **Advanced automation** — event-driven triggers (NATS mesh), DAG playbooks, parameterized runbooks, dagu workflows, MOP change management with automatic rollback.

**v1.6.0 — Workspace foundation:**

- **Global Tab List panel**
  - a new `TAB LIST` panel shows terminal and chat tabs as a vertical workspace inventory, with counts, status dots, latest-first ordering, drag/drop support, close actions, and quick creation for chat, local terminal, and saved-SSH terminal tabs
- **Default workspace refresh**
  - new main layouts start with the list panel on the left, chat in the center, and terminal on the right, making tab-heavy sessions easier to scan immediately
- **More predictable background terminal tabs**
  - local and SSH tabs created from the list panel can start in the background, stay visible in the global terminal inventory, bind to terminal panels when appropriate, and no longer unexpectedly take over linked filesystem or monitor panels
- **Visible compaction boundaries**
  - long chats now persist and render a `[CTX COMPACTED]` marker at the actual retained-history cutoff across desktop, mobile-web, and TUI clients
- **Deterministic compaction fallback**
  - when the compaction model fails or returns an empty summary, GyShell can recover with a local deterministic digest while preserving the protected tail and exporting exact older history for on-demand inspection when available
- **Safer stream recovery**
  - empty non-tool provider stream finishes now retry through the normal path instead of silently ending a run with no answer, while valid empty tool-call finishes remain routable
- **Terminal inventory stability**
  - terminal titles stay unique and stable across duplicate backend snapshots, concurrent terminal creation, explicit numeric suffixes, and detached-window terminal transfers
- **Mobile-web runtime refresh**
  - Electron-packaged mobile-web assets were regenerated so desktop builds serve the updated client without requiring a separate mobile-web development server

---

## Key Capabilities

### AI-Native Runtime

- Thinking-oriented execution for complex tasks.
- Context-aware responses from terminal state and selected resources.
- Per-profile model routing for `Global`, `Thinking`, `Action`, and `Compaction` roles.
- Reusable Agent Setting profiles for model profile, security policy, tools, skills, memory, recursion, and experimental workflow flags.
- Long-session context quality with dedicated compaction models, dynamic summaries, visible `[CTX COMPACTED]` boundary markers, and deterministic fallback recovery when model compaction is unavailable.
- SQLite-backed conversation history with automatic one-time migration from legacy JSON storage.
- AI-assisted terminal command drafting from recent tab context, with paste-before-run control.
- Background (nowait) commands automatically notify the agent on completion, so the agent can close the loop without polling.
- Terminal-targeting agent tools report runtime status and refuse stale operations on disconnected tabs until reconnect succeeds.
- Reference previous conversations with `Pass Chat` mentions; GyShell exports the selected chat as private local Markdown and tells the agent how to read it only when needed.
- Classic or Seamless chat activity display, depending on how much inline tool detail you want.
- Persistent memory injection via `memory.md`, scoped to the active Agent Setting profile when one is applied.
- Multimodal user input pipeline (text + images) for compatible models.
- OpenAI-compatible model endpoint support, with automatic recovery from malformed empty tool-call stream finishes.
- Optional experimental agent tools, including asynchronous cross-machine file transfer between terminal tabs with progress polling.

### Terminal + SSH + File Management

- Shell support: Zsh, Bash, PowerShell.
- Older Windows PowerShell environments now use more reliable sidecar-based command completion tracking for local and SSH sessions.
- SSH support: password/key auth, proxy chaining, bastion workflows.
- SSH sessions use protocol keepalive to reduce silent idle disconnects.
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
- Use the global Tab List panel to scan terminal/chat inventory, restore unhosted tabs, drag tabs across layout targets, close tabs, and create new chat/local/SSH tabs without forcing a terminal panel to appear.
- Save up to three workspace layout slots and restore them from the rail.
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

### Plugin System (v2.5+)

- **Custom plugins** auto-integrate on startup: drop a folder with `plugin.json` + `index.mjs` into `~/.gybackend-data/plugins/` — the agent gets your tools, triggers, and dashboard panels immediately.
- **6 official plugins ship out of the box** (21 tools, 10 triggers, 6 panels):
  - **patch-manager** — autonomous patch management (discover patches via yum/apt/Windows Update, build deployment plans, execute with MOP approval, fleet-wide compliance dashboard).
  - **request-router** — automated request handling (submit/approve/list requests with risk classification → auto-approve/queue/MOP routing).
  - **sop-assistant** — SOP retrieval + step-by-step guided execution; 8 built-in SOPs (restart-service, disk-cleanup, database-failover, incident-response, …) + IAM policy lookup.
  - **iam-connector** — IAM integration (user/group info, privileged access identification, access reviews, disable users with approval) on Linux + Windows.
  - **fraudops** — FraudOps operational layer (Flink/NATS/Kafka pipeline health, STR workflow with deadlines, decision summaries).
  - **netdata-rterm** — Netdata Cloud alert webhook ingestion + correlation with RTerm metrics/incidents for RCA and auto-remediation.

### SRE Observability (v2.0+)

- **Metrics ledger** with per-second snapshots per host (cpu/mem/disk/net/load/gpu) and trend forecasting ("disk full in N days").
- **Golden signals** per host (saturation/traffic/latency/errors) + capacity forecast.
- **Uptime watchdogs** (tcp/ssh/http/command liveness), up/degraded/down with alerting.
- **SLO/SLI** with error budget + burn rate + fast-burn alerting.
- **Incident ledger** with timelines, AI root-cause analysis, and postmortems.
- **Anomaly detection** (z-score + robust z-score) + predictive early warnings with optional MOP auto-remediation.
- **APM** — OTLP distributed-trace store (per-service p50/95/99, error rate, bottleneck services).
- **DEM/RUM** — Core Web Vitals (LCP/INP/CLS/TTFB) per page + error rate.
- **k8s/cloud infra** — cluster health (pods, restarts, node readiness, cpu/mem % of limit).
- **Windows ETW diagnostics** — built-in ETW providers (network/file/registry/process), agentless.
- **UEBA behavior ledger** — agent run baselines + deviations (run-spike, token-blowout, error-spike, unusual-model).
- **Embedded eval harness** — measures the agent's accuracy, tool selection, safety/policy compliance, and determinism.
- **Unified live dashboard** + browser-renderable HTML dashboard.
- **AWS APerf deep-dive** (v2.6+) — deploy aperf to any Linux host for deep CPU/PMU/process profiling with parsed findings feeding the agent's RCA.

### Governance, Audit & the Maker/Checker Model (v2.7+)

- **Hash-chained audit ledger** — every agent action, command evaluation, approval, MOP change, and playbook step is recorded with the SHA-256 hash of the previous record (tamper-evident), plus **Merkle-tree evidence sealing** for independently-verifiable audit bundles.
- **AGT policy engine** — YAML policies evaluated before every consequential action (allow/deny/escalate); glob action patterns, target wildcards (`prod-*`), agent identity + sponsoring principal for zero-trust.
- **Review model (maker/checker)** — a second model independently verifies the action model's output on 5 dimensions: correctness, completeness, safety, compliance, and accuracy. Three modes (strict/advisory/auto-approve); skipped entirely when no review model is configured (fast output mode).
- **Monitor diagnostics** — one-call answer to "why aren't stats displaying?" per terminal (publisher wired? session exists? collection stuck? connected? last-collect time?).

### Automation & Change Management

- **Playbooks** with validation + automatic rollback; **DAG/orchestrated playbooks** with parallel waves.
- **Event-driven triggers** (pattern/threshold/webhook/schedule) firing playbooks or proposing MOP changes, with cooldown + concurrency caps.
- **MOP change management** — plan → approve → run → status with a durable change ledger and automatic rollback on validation failure.
- **Scheduled tasks** (5-field cron) running headless inside the daemon.
- **dagu workflows** — run declarative dagu YAML DAGs natively on the orchestrated playbook engine, no dagu server required.
- **Parameterized runbooks** with `{{param}}` substitution + secret masking; idempotent `desiredState` steps; cross-host `captureVar`.
- **NATS event mesh** — fleet-wide trigger fan-out across multiple RTerm backends.

### Mobile-Web Companion

- Mobile-first remote client for active session tracking and steering.
- Desktop can serve the mobile-web companion directly and expose copyable access links from settings.
- OpenClawd-style conversational control from anywhere while your core runtime stays on your own machine.
- Session list with search and status hints.
- Pending approval badge with jump-to-blocked-session behavior, plus task-completion toasts.
- Conversation rollback and branch-from-message controls from mobile.
- Swipe-to-delete session flow for faster mobile cleanup.
- Read-only terminal output tails with unread indicators, local/saved-SSH terminal creation, and SSH reconnect.
- Detailed turn event inspection from phone browser.
- Tool, skill, Agent Setting profile, terminal, and settings access through gateway RPC.
- Long chat timelines avoid full-list rerenders during composer input, keeping history-heavy mobile sessions responsive.
- Gateway exposure can now be limited to localhost, LAN-only, custom CIDR ranges, or all interfaces.

---

## Platforms

1. **Electron desktop app** (`apps/electron`)
2. **Standalone backend runtime** (`apps/gybackend`)
3. **Deprecated TUI runtime** (`apps/tui` wrapper + `packages/tui` core)
4. **Mobile-web runtime** (`apps/mobile-web` wrapper + `packages/mobile-web` core)

### Which Surface Should You Use?

- **Desktop app**: primary full-featured experience for daily development.
- **TUI (`gyll`)**: deprecated and unsupported. Desktop packages no longer bundle or install `gyll`.
- **Mobile-web**: OpenClawd-style remote conversational control from phone/browser.

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Development

```bash
git clone https://github.com/MrOrangeJJ/RTerm.git
cd RTerm
npm install
npm run dev
```

### One-line Mental Model

`RTerm = persistent AI runtime + real terminal control + human override at any time.`

### Mobile-web development

```bash
npm run dev:mobile-web
```

---

## Deprecated CLI (`gyll`)

After installing and launching RTerm desktop once, `gyll` is available from the desktop runtime setup.

When an existing user updates from a version that installed desktop-managed `gyll` launchers, the updated app removes those legacy launchers on startup while leaving any shell profile PATH block untouched.

---

## Architecture Notes

RTerm follows strict layering:

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

- Release notes: `changelogs/v1.6.0.md`
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

This project is licensed under the **Apache License, Version 2.0** ([LICENSE](./LICENSE)).

Special acknowledgment: inspirations and references from [Tabby](https://github.com/Eugeny/tabby) (MIT).

---

**RTerm** - _The shell that thinks with you._
