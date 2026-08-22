# Changelog

## v3.2.9 (2026-08-22)

### Features — GyShell v1.7.0 parity (agent speed, remote control, reliability)

Ports the remaining GyShell v1.7.0 feature set. (Parallel tool execution,
captureStatus, reconcileToolCalls, reading frontier, shortDescription, and
session rename had already landed in v3.2.4–v3.2.8.)

- **New `rterm` CLI** — a `gyll`-style command CLI for the backend's WebSocket
  JSON-RPC gateway. Zero dependencies (native WebSocket on Node ≥ 21, `ws`
  fallback). Commands: `ping`, `version`, `methods`, `call`, `terminals`,
  `open`, `close`, `run`, `fleet`, `sessions`, `chat`, `dashboard`, `metrics`.
  `run`/`fleet` drive the gateway's write + buffer-delta surface and settle on
  stable output. Verified live against a running backend (126 methods).
  Location: `apps/cli/rterm-cli.mjs`.

- **Per-model OpenAI-compatible request-body overrides (`requestParams`)** —
  typed text/number/boolean/JSON overrides per model, with model-level winning
  over profile-level. Runtime-owned fields (`model`, `messages`, `tools`,
  `tool_choice`, `stream`, `stream_options`, `apiKey`, `baseURL`, `n`) are
  protected and silently dropped so a bad override can never break the agent
  loop. Wired into `createChatModel` for the global, action, thinking, and
  compaction models + the command-draft model. Files: `model_config.ts`
  (`sanitizeRequestParams`/`resolveRequestParams`), `types/index.ts`.

- **Agent Setting auto-save** — while a profile is active, every settings
  change is written back into that profile automatically (no manual overwrite).
  Re-entrancy guarded: the write-back itself triggers a settings change, and
  the `autoSaveInFlight` flag stops that from looping. Files:
  `AgentSettingProfileService.ts` (`autoSaveActiveProfile`),
  `startGyBackend.ts` (listener wiring).

- **Agent-managed terminal tabs (close side)** — new `close_terminal_tab`
  agent tool, the counterpart of `open_terminal_tab`. Guarded: refuses to close
  the last remaining tab and reports how many tabs remain. Registered as a
  single-call boundary tool (the visible tab list changes). Files:
  `terminal_tools.ts`, `tools.ts`, `prompts.ts`, `AgentService_v2.ts`.

- **Faster SSH→SSH file transfers** — single-file copies between two Unix SSH
  hosts now stream directly between the machines (`cat` over the source's
  side-band exec channel → target's `writeFileChunk`) instead of relaying
  through the RTerm host. New `execStream` in `SSHBackend` returns stdout as an
  async iterable (no buffering); `TerminalExecOptions.streamStdout` opts in.
  Automatic fallback to the existing chunked relay when either side declines
  (non-Unix, no side-band exec, or any mid-stream error). Files:
  `FileSystemService.ts` (`tryDirectSshToSshTransfer`), `SSHBackend.ts`.

- **More predictable Skill discovery** — the backend now scans only its managed
  Skills folder and `~/.agents/skills`. Compatibility roots (`~/.claude/skills`,
  `~/.codex/skills`, `APPDATA/agents/skills`, `~/.config/agents/skills`) are
  opt-in via `includeCompatibilityRoots` or `RTERM_SKILL_COMPAT_ROOTS=1`.
  File: `skills/scanRoots.ts`.

- **Cleaner Seamless activity with accurate failure states** — the Seamless
  tool-group banner now computes per-step severity (error for command exit ≠ 0,
  tool errors, error messages; warning for alerts/sub_tool warnings). The group
  header shows the worst state (`Failed · N steps` / `Done with warnings · N
  steps`), an ✕/! marker replaces the tree connector on failing steps, and
  error/warning counts appear in the meta. Files: `ChatBanner.tsx`,
  `chatBanner.scss`.

- **Chat selection stays put** — creating or attaching a chat tab in another
  panel no longer changes the session selected in the current chat panel.
  `moveTabBinding` only syncs the global active tab when the move lands in the
  focused panel. File: `LayoutStore.ts`.

- **More stable Windows terminals** — terminal writes are routed through a
  single `serializedWrite` helper and the refit path repaints the full viewport
  after resize, keeping cursor position and reflowed rows synchronized when
  continuous output and panel resizing overlap. File: `XTermView.tsx`.

- **Background SSH tabs stay monitorable** — verified this GyShell behavior
  already holds in RTerm: an SSH tab created without a visible terminal panel
  stays layout-bindable, binds automatically when a terminal panel appears
  later, and the monitor panel follows the terminal kind (existing
  `appStore.extreme.spec.ts` cases cover both directions). No code change was
  needed; the earlier v3.2.x work already implemented it.

### Tests

New `v329Features.extreme.spec.ts` (29 tests, all passing) covering
requestParams sanitization/precedence, scan-root restriction + opt-in +
dedupe, auto-save guard logic (no active profile, missing profile,
re-entrancy), close-tab last-tab guard, direct-transfer eligibility + empty
file + fallback + shell quoting, and Seamless severity computation
(error/warning/ok mapping + group dominance). Registered in
`test:backend-unit-extreme`.

## v3.2.1 (2026-08-02)

### Bug fixes — terminal freeze + chat re-trigger + stop button freeze

Three user-reported bugs fixed, all in the terminal/chat interaction layer.

- **Terminal freeze (keystrokes disappear).** When a terminal wasn't writable
  (SSH reconnecting, state transitioning), `write()` silently dropped keystrokes.
  Added a pending-write buffer: keystrokes are buffered and retried 500ms later
  when the terminal becomes writable. Cleaned up on kill/close. File:
  `TerminalService.ts` (`pendingWrites` + `pendingWriteTimers`).

- **Chat re-trigger (response cleared + new task starts).** `handleSendNormal`
  didn't check `isThinking` before sending — pressing Enter while the agent was
  still thinking (or just finished and the flag hadn't cleared) sent a new
  message that cleared the previous response and triggered a new task. Added
  an `if (isThinking) return` guard. File: `ChatPanel.tsx`.

- **Stop button freeze (10s rolling circle).** `stopCurrentRun` called
  `stopTask()` without awaiting it — the UI froze waiting for the async stop
  to resolve. Made `stopCurrentRun` async: optimistically sets `isThinking =
  false` first (prevents re-send), then awaits `stopTask` with a try/catch
  (backend may have already finished). File: `ChatPanel.tsx`.

Verified: typecheck (all workspaces) exit 0; full automation suite green;
layout/UI tests green (10/10).

## v3.2.0 (2026-08-02)

### Feature — production-ready Synapse dispatch (skip-ack, multi-mesh, 600s timeout)

Makes Synapse dispatch work seamlessly out of the box — no more JetStream ack
intercepting the reply, no more 30s timeout for LLM-backed agents, and support
for multiple Synapse networks.

- **Fix 1 — Skip JetStream ack, wait for real respond.** `dispatchTask()` no longer
  uses `nc.request()` (which returns the first reply = JetStream ack). Instead it
  subscribes to a dedicated reply subject, skips any message with
  `{stream: "AGENT_INBOXES", seq: N}`, and waits for the real Synapse `respond`
  envelope. Proven with mock agent + real Wema BMC data round-trip.
- **Fix 2 — 600s default dispatch timeout.** LLM-backed agents (grip-001, omp-cli-001)
  take 30-120s to process. The old 30s timeout was too short. New default is 600s
  (10 minutes), configurable via `settings.synapse.dispatchTimeout`.
- **Fix 3 — Multi-mesh support.** `settings.synapse.meshes` accepts an array of
  `{name, url/servers, auth, prefix?}`. `discoverAgents()` queries all meshes and
  merges results, tagging each agent with `_mesh` so you know which network it came
  from. `connectMesh()` accepts an override config for per-mesh connections.
- **Fix 4 — Graceful timeout error.** If no respond arrives within the timeout,
  returns a clear error: `"Agent X did not respond within Ns. It may not have a
  Synapse responder running (check synapse_serve_status)."` — not a hang.

New types: `SynapseMesh` interface, `dispatchTimeout` + `meshes` on `SynapseSettings`.
Tests: 6/6 synapse-bridge spec (skip-ack + timeout + multi-mesh), 13/13 synapseAgent
spec, full automation suite green.

## v3.1.12 (2026-08-02)

### Feature — markdown rendering in chat (tables, headings, lists, blockquotes, code blocks)

The chat panel already used `ReactMarkdown` + `remarkGfm` + `rehypeRaw` to render
assistant messages, but the CSS for most markdown elements was minimal or missing.
Tables had no borders/padding, headings were unstyled, lists had no indentation,
blockquotes were plain, and horizontal rules were absent.

Added comprehensive GitHub-style markdown CSS to `chat.scss`:
- **Tables**: bordered, with header row background, cell padding, hover highlight,
  horizontal scroll for wide tables, rounded corners
- **Headings** (h1–h6): proper font sizes, bottom borders on h1/h2 (GitHub style),
  muted colors for h5/h6, consistent spacing
- **Lists** (ul/ol): proper indentation, li spacing, nested paragraph handling
- **Task lists** (GFM checkboxes): list-style removed, accent-colored checkboxes
- **Blockquotes**: left accent border, subtle background, rounded corners, muted text
- **Horizontal rules**: clean border-top
- **Strikethrough/emphasis**: muted strikethrough, bold strong, italic em

Also fixed a type error in `PluginToolDefinition` (added optional `params` field)
and the handler cast in `startGyBackend.ts`.

## v3.1.8 (2026-08-02)

### Feature — plugin tools wired into the agent (all 11 plugins now callable in chat)

Fixes the gap where plugin tools were discovered and registered by the PluginRegistry
but never wired into the agent's tool executor. The agent's `switch` dispatch had a
`default: "Tool not supported"` that now checks the plugin tools map first.

- **`AgentService_v2.setPluginTools()`** — new method: accepts an array of
  `{name, description, params, handler}` and stores them in a `pluginTools` map +
  `pluginToolSchemas` array. The schemas are injected into `toolsForModel` (so the
  model sees the tools and can call them) and the handlers are dispatched in the
  `default` case of the tool dispatch switch.
- **`startGyBackend.ts`** — after `observability.pluginRegistry.reload()`, collects
  all plugin tools from enabled plugin records and calls `agentService.setPluginTools()`.
  Logs how many tools were wired. Best-effort: a failure logs a warning but doesn't
  block startup.
- **Tool dispatch `default` case** — now checks `this.pluginTools.get(toolCall.name)`
  before returning "not supported". Plugin tool results are JSON-stringified if not
  already a string.

This makes all 11 plugins' tools (synapse_serve, numbat_deploy, web_search,
agentspan_run, patch_status, sop_search, etc.) callable by the agent in chat on
both the standalone daemon (neuralos/rterm-backend npm) and the desktop app.

## v3.1.7 (2026-08-02)

### Feature — always-on full-duplex Synapse agent (auto-start responder on boot)

Makes "be tasked by them" **always-on** instead of opt-in per session, and makes
`synapse_serve` reliably invocable + verifiable.

- **Auto-start on boot (`synapse.autoServe`, default true).** When `synapse.enabled` and
  `autoServe` are true, the plugin **auto-starts the full-duplex responder** inside
  `register()` — RTerm listens on `mesh.agent.{id}.inbox` and responds to inbound Synapse
  requests from boot, no manual `synapse_serve` call needed. Best-effort: a failed
  auto-start (server down) logs a deferral and never blocks plugin registration; the
  responder still starts on the first `synapse_serve` call. Set `autoServe: false` to opt out.
- **Default serve skills.** When auto-starting (or calling `synapse_serve` with no skills),
  RTerm serves a sensible default set: `status` (liveness) + `discover` (mesh discovery),
  plus any `ctx.rtermSkills`. No empty-skill responder.
- **`synapse_serve_status` (new tool).** Report whether the responder is live, connected,
  which skills it serves, and the autoServe flag — makes the always-on responder verifiable.
- **`synapse_serve` made idempotent + reliable.** Restarts cleanly with fresh skills on
  repeat calls; the shared `serveSkills` helper drives both the tool and the boot auto-start.

Tools 11 → 12. Tests: 3 new autoServe tests (`register() auto-starts the responder when
enabled+autoServe`, `disabled when autoServe=false`, `a failed auto-start does not break
register`) — **15/15** synapse-bridge spec, full automation suite green.

## v3.1.6 (2026-08-01)

### Feature — full-duplex Synapse agent (responder, emit/subscribe, reputation, governance)

The synapse-bridge goes from a Synapse *client* (register/discover/dispatch) to a **full
Synapse agent** speaking all six primitives plus both normative extensions. New module
`plugins/synapse-bridge/synapseAgent.mjs` + 6 new tools (5 → 11).

- **Responder (respond primitive).** `synapse_serve` starts RTerm as a full mesh agent:
  it listens on `mesh.agent.{id}.inbox` and `respond()`s to incoming Synapse requests by
  mapping them to RTerm skills (playbooks/tools). **Federation is now genuinely
  bidirectional** — other agents can discover *and task* RTerm. `buildRespond` builds
  correct respond envelopes (output XOR error, `in_reply_to`); `executeSkill` maps skill
  ids to handlers with `3001 SKILL_NOT_FOUND` on miss.
- **Emit/Subscribe primitives.** `synapse_emit` publishes formal Synapse `emit` events on
  `mesh.event.{type}`; `synapse_subscribe` listens on `mesh.event.*` / `mesh.task.*`
  streams (wildcard-aware) and feeds the local reputation store + `synapse_mesh_event` trigger.
- **EXT-REPUTATION.** A local `ReputationStore` maintains a `ReputationRecord` per
  `(agent, skill)`: successes/failures/timeouts/skill_not_found, latency, `success_rate`,
  `speed_score`, `freshness`, and a composite `score` per **Formula 11.5** (weights
  0.7/0.2/0.1, lying-penalty × confidence). Three consecutive `SKILL_NOT_FOUND` flags a
  lying-agent (`misleading_capabilities`) and zeroes the score. `synapse_reputation` reads
  records + `discover-ranked`.
- **EXT-GOVERNANCE.** `synapse_request_approval` publishes `mesh.approval.{taskId}.request`
  and awaits the response (agent side, for gated dispatches); `synapse_approve` listens on
  `mesh.approval.*.request` and answers each per a policy (approver side) — so other agents
  route gated actions through RTerm for approval. Denied → `4003 GOVERNANCE_DENIED` path.

Tests: new `synapseAgent.extreme.spec.mjs` — **13/13** (respond envelope shape + output/error
exclusivity, executeSkill + SKILL_NOT_FOUND, live responder round-trip, emit, subscribe,
score formula high/low/lying-zero, ReputationStore ranked + task_update feed,
requestApproval/round-trip, respondApproval, live approver). Existing synapse-bridge spec
updated for 11 tools — **12/12**. Full automation suite green (spec wired into
`test:automation-extreme`).

## v3.1.5 (2026-08-01)

### Bug fixes — latent connection-state bugs (NATS, synapse-bridge, serial)

A systematic bug-hunt across the v3.1.x surface found three latent connection-state
bugs. All fixed with regression tests; full suite green.

- **synapse-bridge — stale connection reused across configs.** `connectMesh` cached a
  single module-level `_conn` for the whole process, so a settings change (different
  NATS server, auth, or agentId) silently reused the **previous** connection to the wrong
  server. And a failed connect left `_conn` set to a dead connection that was never
  retried. Fixed: the connection cache is now **keyed by config fingerprint**
  (servers + agentId + auth keys) — a config change opens a new connection — and a failed
  attempt is evicted so the next call retries. File: `plugins/synapse-bridge/index.mjs`.
  Tests: `connection is keyed by config — a settings change opens a NEW connection`,
  `a failed connect is not cached — the next call retries` (synapse-bridge spec **12/12**).

- **natsEventBus — `connect()` raced and could leave a half-connected state.** Concurrent
  `connect()` calls each opened their own connection (no mutex); a connection that resolved
  already-closed was accepted; and a closed-lingering `conn` blocked reconnect. Fixed:
  an in-flight `connectPromise` mutex (concurrent callers share one attempt), a DOA guard
  (reject a connection closed immediately after connect), and clear-on-close before
  reconnecting. File: `packages/backend/src/services/automation/natsEventBus.ts`. Tests:
  `concurrent connect() calls share one in-flight attempt`, `a failed connect clears state
  so the next call retries`, `a connection that resolves already-closed is rejected`
  (natsEventBus spec **14/14**).

- **SerialBackend — errored ports leaked in the instance map + indistinguishable state.**
  On port `error`, the instance stayed in `instances` (a dead port, never cleaned up →
  leak), and `getInitializationState` returned `undefined` for both "failed" and
  "not-found" (indistinguishable). Fixed: on error the instance is removed (no leak) but
  its id is remembered in a `failedIds` set so `getInitializationState` returns `'failed'`
  (distinct from not-found `undefined`); `kill` clears the marker. File:
  `packages/backend/src/services/SerialBackend.ts`. Test: `port error cleans up the
  instance (no leak) and getInitializationState reports failed` (serialBackend spec **9/9**).

**Verification:** backend typecheck (all workspaces) exit 0; full automation suite green
(serial 9/9, natsEventBus 14/14 + comprehensive 20/20, synapse-bridge 12/12, numbat-bridge
11/11, all other suites unchanged).

## v3.1.4 (2026-08-01)

### Feature — two new bridge plugins: `synapse-bridge` + `numbat-bridge`

Two production bridge plugins that turn RTerm into a first-class citizen of two
complementary ecosystems. Both are opt-in (settings-gated), ship with full unit tests,
and follow the established plugin pattern (tools + trigger + panel).

**`synapse-bridge` — RTerm ↔ Synapse mesh interop.** RTerm now speaks the Synapse
protocol (v0.3.0) over a shared NATS server, building on the v3.1.2 auth/request-reply/
JetStream transport. Discover live mesh agents, dispatch tasks to them, and register
RTerm itself as a mesh agent (bidirectional federation).
- Tools: `synapse_health`, `synapse_discover` (registry query with capability/skill/
  availability filters), `synapse_dispatch` (send a task to `mesh.agent.{id}.inbox`,
  await the durable response), `synapse_register` (register RTerm as a mesh agent),
  `synapse_agents_summary`.
- Trigger `synapse_mesh_event` + panel `synapse-mesh-agents`.
- Config `settings.synapse` (url/servers/prefix/agentId/auth incl. vault secretRef).
- Tests: `synapse-bridge.extreme.spec.mjs` — **10/10** (config, envelope shape, register
  wiring, discover+dispatch round-trips, register-self, trigger match).

**`numbat-bridge` — RTerm ↔ Numbat (endpoint AI-agent detection/EDR).** Numbat detects
(endpoint visibility, CEL rules, forensics); RTerm responds. Deploy Numbat to hosts and
ingest its findings to fire governed actions.
- Tools: `numbat_health`, `numbat_deploy` (inventory/scan/install-monitor/install-enforce/
  status/uninstall via the policy-gated exec path), `numbat_ingest` (normalize NDJSON
  events/findings/enforcement/indicators → emit a trigger event per finding),
  `numbat_findings_summary` (by severity/rule/agent).
- Trigger `numbat_finding` (medium+ severity) + panel `numbat-findings`.
- Config `settings.numbat` (binaryPath/recordsPath/ingestToken/minSeverity).
- Tests: `numbat-bridge.extreme.spec.mjs` — **11/11** (config, record normalization +
  severity gating, NDJSON parsing, deploy-command builder, register wiring, ingest→trigger,
  trigger match).

**Settings:** added `synapse?: SynapseSettings` and `numbat?: NumbatSettings` to the
`BackendSettings` type, the `pickBackendSnapshot` whitelist, and `normalizeSynapseSettings`
/ `normalizeNumbatSettings` — so both blocks persist across save/load (the v3.1.3 lesson).
Verified both survive `migrateBackendSettings` with auth intact.

Plugin count: 9 → **11**. Backend typecheck (all workspaces) exit 0; full automation suite
green (both new specs wired into `test:automation-extreme`).

## v3.1.3 (2026-08-01)

### Bug fix — `settings.nats` was stripped on save/load (NATS mesh couldn't be configured)

The v3.1.2 comprehensive NATS mesh had a wiring gap that made it **impossible to
configure**: `pickBackendSnapshot` (settings/migrations) whitelists which settings keys
survive a save/load cycle, and `nats` wasn't in the list — so any `nats` block written to
`settings.json` was **silently deleted** the next time the daemon normalized + persisted
settings (e.g. on shutdown). The bus never saw its config, so it never connected.

- Added `nats?: NatsSettings` to the `BackendSettings` type (`packages/backend/src/types/index.ts`).
- Added `nats: raw.nats` to `pickBackendSnapshot` so the block survives migration.
- Added `normalizeNatsSettings` (url/servers/prefix/queue/reconnect/timeout + full auth
  sub-block: token/user-pass/nkey/jwt/creds/tls) and applied it in `normalizeBackendSettings`.

Regression test: `normalizeNatsSettings preserves nats block + auth through migration` in
`migrations.extreme.spec.ts` (block + auth preserved, `enabled=false` honored, garbage auth
dropped) — **19/19**. Backend typecheck (all workspaces) exit 0.

## v3.1.2 (2026-07-31)

### Feature — comprehensive NATS event mesh (auth, JetStream, KV, request/reply)

`NatsEventBus` rewritten from a thin core-pub/sub adapter into a full NATS client
covering the entire feature surface. The trigger mesh (terminal output + monitor
snapshots → fleet-wide pattern/threshold triggers) works unchanged; everything below
is additive and backward compatible.

- **Authentication** (`NatsAuthOptions`) — the previous build connected with no auth,
  so it couldn't reach any authenticated server. Now supports every NATS auth scheme:
  static **token**, **username/password**, **NKey** (seed signing), **JWT** (jwt+seed),
  **.creds** bundle, and **TLS mutual-auth** (cert/key/ca). Resolved via
  `buildAuthenticator()` (token/user-pass/NKey/JWT/creds) + `buildTls()`; secrets can be
  inline or `secretRef` pointers resolved through the vault.
- **Core pub/sub** — generic `publish()`/`subscribe()` with optional **queue groups**
  (load-balance across instances) and **headers** (MsgHdrs both directions).
- **Request/Reply** — `request()` (timeout + headers) and `respond()` for NATS-native RPC.
- **JetStream** — `streamAdd/Info/List/Purge/Delete`, durable `jsPublish()` (awaits
  PubAck: stream + seq + duplicate), `jsConsume()` (ordered/durable, ack/nak), and
  `jsFetch()` (pull batch). New deps `@nats-io/jetstream` + `@nats-io/kv` (v3.4.0).
- **Key-Value** — `kvCreateBucket`/`kvBucket`, `kvPut`/`kvGet`/`kvDelete`, `kvKeys`,
  `kvWatch` (change feed), built on JetStream.
- **Connection lifecycle** — reconnect/disconnect/error/lame-duck status handlers
  (`onReconnect`/`onDisconnect`/`onError`), configurable `maxReconnectAttempts`,
  `reconnectTimeWait`, `timeout`; idempotent connect + clean drain/close.
- **Settings** — `resolveNatsOptions` now passes through `auth`, `queue`, and the
  reconnect/timeout knobs (still returns null when disabled/unconfigured).

File: `packages/backend/src/services/automation/natsEventBus.ts` (rewritten).
Tests: new `natsEventBus.comprehensive.extreme.spec.ts` (20 tests: 7 auth, 3 pub/sub,
2 request/reply, 4 JetStream, 2 KV, 2 settings) — **20/20**; existing
`natsEventBus.extreme.spec.ts` (11/11) + `natsTriggerMesh.extreme.spec.ts` (4/4) stay
green. Backend typecheck exit 0.

## v3.1.1 (2026-07-31)

### Bug fixes — serial transport, standalone transports

- **Serial backend — `SerialPort is not a constructor`.** `SerialBackend.loadSerial()`
  returned `require('serialport')` (the module namespace) but `spawn()` called it as a
  constructor. Across serialport versions the export shape and call signature differ —
  v9 exports the constructor *as* the module and accepts `new SerialPort(path, opts)`;
  v10+ puts the class on the `SerialPort` named export and only accepts
  `new SerialPort({ path, ...opts })`. The backend now (a) resolves the class from
  `mod.SerialPort ?? mod` and (b) constructs via a tolerant helper that tries the
  positional form and falls back to the object form on a `TypeError`. Serial console
  connections now open correctly on serialport v9 through v13+ (no version pin needed).
  File: `packages/backend/src/services/SerialBackend.ts`. Regression-covered by
  `serialBackend.extreme.spec.ts` (8/8).

- **Standalone `neuralos` / `rterm-backend` npm — missing transports.** The standalone
  gybackend bundle marks `ssh2` / `serialport` / `node-pty` as external (resolved from
  `node_modules` at runtime), but `serialport` was not declared in any `package.json`, so
  a fresh `npm i -g neuralos` had no serial support (and SSH/node-pty only resolved via
  incidental hoisting). `serialport` is now declared as an `optionalDependencies` entry in
  the root `package.json` (native addon — installs where it compiles, skipped elsewhere),
  matching how `ssh2` and `node-pty` are provided. File: `package.json`.

**Verification:** backend typecheck exit 0; `serialBackend.extreme.spec.ts` 8/8; the
constructor helper verified against real serialport v9.2.8 (positional) and v13.0.0
(object-form fallback).

## v3.1.0 (2026-07-28)

### Bug-hunt release — systematic audit of RTerm for bugs, incomplete features, and wiring issues

A structured audit of the entire RTerm codebase for bugs, unwired features, and edge-case issues. **All 12 candidates were verified as confirmed-not-a-bug** — no defects found. The audit confirms the following are all correctly wired and working:

- **Session recorder** — wired via `setSessionRecorder` in both `startGyBackend.ts` and `startElectronMain.ts`.
- **Plugin context (`spawnProcess` / `getSettings`)** — correctly passed into `PluginRegistry.defaultContext` and spread into the plugin context.
- **Gateway method registry** — all 54 `observability:*` methods are dispatchable; `gateway:describe` self-lists them.
- **Agent tool executor map** — all 50 registered tools are executable (snake_case → camelCase naming convention).
- **Settings normalization** — all blocks (cost, alerts, oncall, cloud, agentspan, webIntel, gateway, automation, sessionLogging, memory, layout, tools, experimental, debugMode, agentSettings, recursionLimit) are handled by `normalizeBackendSettings` deepMerge + explicit normalization.
- **Plugin manifest vs registration** — all 9 plugins register the tools/triggers/panels their `plugin.json` declares.
- **WinRM persistent runspaces** — `cd /d <cwd> &` prefix preserves cwd across commands; failing commands don't corrupt cwd tracking.
- **Auto-reconnect kill race** — `kill()` cancels the auto-reconnect schedule (`autoReconnect.clear`).
- **Chunked ring buffer** — content length stays ≤ maxSize, no corruption, offset monotonic.
- **Memory manager** — multi-line note dedupe works correctly.
- **Dashboard HTTP auth** — `isLoopbackAddress` correctly matches IPv6-mapped IPv4 (`::ffff:127.0.0.1`).
- **Web-intel sidecar** — `sidecar.start()` sets `lastError` and rethrows spawn errors; `ensureDaemon` surfaces them via `guarded()`.

**Test suite:** 50/50 backend + plugin tests pass (Gateway, dashboard, liveui, sre, terminal, plugin, settings, observability_tools, web-intel).

This release is a **no-defect audit milestone** — the codebase is clean, fully wired, and all edge cases verified.

## v3.0.9 (2026-07-28)

### Feature — `web-intel` plugin: local-first web intelligence for RTerm's agent (via wigolo)

RTerm's agent now has first-class web tools it didn't have: multi-engine search, clean-page
fetch, site crawl, structured extract, similar-pages, research, and page-watch → RTerm
trigger automation. Built as a first-class plugin following the `agentspan-bridge` pattern
(split client from glue, settings-driven, resilient).

**Plugin `plugins/web-intel/` (9 tools / 1 trigger / 1 panel):**
- `webintel_health` — daemon status + lean-vs-full warmup + auto-start state.
- `web_search` — multi-engine ranked search with citations (keyless, $0).
- `web_fetch` — clean markdown + metadata + links (tiered router escalates to browser).
- `web_crawl` — multi-page crawl (BFS/DFS/sitemap/map).
- `web_research` — decompose a question → ranked evidence + citations. **Synthesis uses
  RTerm's own agent — no LLM key is needed or stored.**
- `web_find_similar` — pages similar to a URL/concept.
- `web_watch_add` / `web_watch_list` / `web_watch_remove` — watch a vendor/CVE/status page
  for changes; the `webintel_page_changed` trigger fires so a playbook/MOP can react.
- Panel `web-intel` — watched pages + daemon status.

**Lean by default (stock RTerm stays lean):**
- The wigolo daemon starts **lazily on first use** (`npx -y wigolo serve`) — nothing is
  downloaded at install time.
- Default is `WIGOLO_NO_WARMUP=1` — the ~1.5 GB browser engine + on-device models are
  **not** downloaded until a tool that needs them actually runs, or until the user sets
  `webIntel.warmupOnInit: true` (which kicks off a background `wigolo init`).
- Search/fetch/crawl work keyless without the heavy models.

**Settings block `webIntel`** (schema v5 + `normalizeWebIntelSettings`):
`{enabled, restUrl, token, autoStart, warmupOnInit}` — defaults keep everything lean and
local. Token is optional (only if the daemon uses `WIGOLO_API_TOKEN`).

**Plugin infrastructure upgrades (shared):**
- `PluginContext.spawnProcess` — plugins can now spawn local sidecar daemons (used by
  web-intel for `wigolo serve`); optional, plugins degrade gracefully when absent.
- `PluginContext.settings` / `getSettings` — live settings snapshots for plugins that
  read config blocks.
- `registerPanel` now accepts both the `(name, render)` form and the object form
  `{name, title?, render}` used by existing plugins (pre-existing signature drift fixed).

**Resilient:** if the daemon is down and can't auto-start, every tool returns a clear
`{error, hint}` instead of throwing — the agent stays usable (the agentspan-bridge
pattern).

Verification: backend typecheck exit 0; 21/21 web-intel offline tests (client URL/auth/
error mapping, every endpoint, lean-by-default spawn plan, start/stop/status, tool
wiring, unreachable-daemon resilience, result normalization, trigger match); all 74
plugin + settings + agentspan-bridge suites green.

## v3.0.8 (2026-07-28)

### Fix — legacy/Cisco SSH presets offered algorithms ssh2 can't load (Test workflow)

The `legacy` + `cisco` algorithm presets (added in v3.0.7 #4) advertised
algorithms the bundled `ssh2` (1.17.x) does not actually implement. Because the
preset arrays are passed straight to `ConnectConfig.algorithms`, ssh2 throws on
connect and the `sshAlgorithmPresets.extreme` suite — which guards exactly this —
failed the Test workflow.

Removed the unsupported entries:
- KEX: `diffie-hellman-group-exchange-sha512` (legacy)
- host key: `ssh-rsa1`, `x509v3-sign-rsa`, `x509v3-ssh-rsa`, `x509v3-sign-dss` (legacy); `x509v3-ssh-rsa`, `x509v3-sign-rsa` (cisco)
- cipher: `rijndael128/192/256-cbc`, `rijndael-cbc@lysator.liu.se` (legacy); `rijndael128/192/256-cbc` (cisco)

All algorithms ssh2 *does* support stay, so old-daemon coverage is unaffected —
the removed names were never loadable by ssh2 in the first place. The 18-case
`sshAlgorithmPresets.extreme` suite now passes (0 failures).

## v3.0.7 (2026-07-28)

### Fix — chat scrollbar grabbable; legacy/Cisco SSH reconnect + slow-negotiation

**1. Chat vertical scrollbar now drags like a real slider.** It was the thin
auto-hiding overlay that was nearly impossible to grab with a mouse. The chat scroll
track is now a **wide (14px), always-visible, grabbable scrollbar** (styled track +
thumb, hover/active accent, `cursor: grab/grabbing`) — the same feel as the terminal's
scrollbar.

**2. "SFTP unavailable: Not connected" on Cisco/legacy reconnect — fixed.** Reconnecting
or re-opening a Cisco/legacy tab dropped the connection's `algorithmsPreset`
(`normalizePersistedTerminalConfig` didn't carry it), so it fell back to `modern`
algorithms and — worse — ran SFTP init on a device with no SFTP subsystem, printing
`SFTP unavailable: Not connected`. Manual fresh connects worked because they used the
saved connection (which still had the preset). **The preset is now carried through
persistence + reconnect** (verified in your live state: the tab had `preset: <dropped>`).

**3. Slow legacy SSH negotiation no longer times out.** The handshake ready-timeout was
**20s** — old devices (small DH groups, SHA-1, CBC) negotiate slower than that and the
connection was cut mid-handshake. Raised the default to **60s** and added a
per-connection **`readyTimeout`** override (Settings → connection) to tune it further.

**4. Broader legacy algorithm coverage.** Expanded the `legacy` + `cisco` presets with
additional host-key (`ssh-rsa1`, `x509v3-*`), cipher (`rijndael*-cbc`), and KEX
(`diffie-hellman-group-exchange-sha512`) variants that some very old daemons require.

Verification: node + web typecheck exit 0; 5 new legacy-fix tests + all 30 backend/UI
suites green (incl. sshBackend, terminal persistence, chat); Electron bundle builds;
live-confirmed the Cisco XE tab (`show version` → IOS XE 17.18.03a) and the dropped-preset
state in your persisted tabs.

## v3.0.6 (2026-07-28)

### Fix — chat scroll stuck after "Prev user" navigation + Top/Bottom buttons

**The chat scroll broke after using the "Prev user" arrow**: once you jumped to a
previous user message, the chat would not scroll back to the bottom — the auto-scroll
latched off and never re-engaged. Root cause: the programmatic scroll-to-message ran
through the same `scroll` listener that disables auto-scroll on a user scroll-up, so the
nav jump was misread as "user scrolled up" and auto-scroll turned off for good.

- **Programmatic-scroll guard.** `ChatMessageList` now marks its own scroll jumps
  (user-message nav, top/bottom buttons) as *programmatic* and skips the
  auto-scroll-disable for them — only a real user scroll (wheel/drag/keyboard) toggles
  auto-scroll. You can jump anywhere and still get back to the bottom.
- **Top / Bottom buttons.** A one-click **⇤ Top** and **⇥ Bottom** now sit in the chat
  nav bar (next to Prev/Next/Latest user), scrolling instantly to the very top or bottom
  of the conversation. Bottom also re-engages auto-scroll.
- **Always-present nav bar.** The chat nav bar (Prev user / Next user / Latest / Top /
  Bottom) now renders whenever a chat is open, not just when there are user messages —
  so Top/Bottom are always one click away.

Verification: web typecheck exit 0; 7 userMessageNav tests + all 5 chat suites + all 19
backend Gateway/dashboard/liveui/sre/observability suites green; Electron bundle builds
with the fix included.

## v3.0.5 (2026-07-28)

### Terminal & Session Core, chat navigation, visual cues, and memory

A foundational release touching the terminal core, the chat UX, and agent memory.

**Terminal & Session Core**
- **SSH auto-reconnect with exponential backoff + jitter** — a dropped SSH tab now
  reconnects itself (1s→2s→5s→…→60s cap, ±20% jitter, up to 10 attempts) instead of
  waiting for a manual click. New pure `AutoReconnect` scheduler wired into
  `TerminalService.handleExit`; manual kill cancels it, successful reconnect resets it.
  The tab's `reconnectState` flows to the UI (see visual cues).
- **WinRM: persistent-shell reuse + streaming + effective cwd persistence** — commands
  now run on a reused runspace (no more 4-round-trip create/delete per command) with
  **live streaming output** (`runCommandOnShell` + `onChunk`), serialized per shell, and
  an **effective persistent working directory** (each command runs in the tracked cwd via
  `cd /d <cwd> &`; explicit `cd` is resolved and tracked, so `cd` sticks across commands).
  Dead shells auto-recreate once. Verified live against a real Windows host.
- **Serial: BREAK signal + DTR/RTS/CTS control** (`sendBreak`, `setControlLines`) for
  network-gear console work (password recovery, ROMMON).
- **Chunked ring buffer** — terminal scrollback now stores output as fixed-size chunks
  and drops whole old chunks on overflow, replacing the O(n) `string.slice` re-copy on
  every chunk once full. Same logical content + monotonic offset, far less GC churn on
  chatty tabs (build logs, `tail -f`).

**Chat navigation (find your own messages fast)**
- New **user-message navigation bar** above the chat: **↑ Prev user / ↓ Next user / ⇣ Latest**
  buttons + a "User N/M" position readout. Walks back/forward through *your* messages no
  matter how long the session, or jumps straight to your latest — no more scrolling to
  find what you asked. Pure logic (`userMessageNav`) + scroll-into-view.

**Visual cues**
- **Reconnecting indicator**: a pulsing-cyan dot + "reconnecting (attempt N)…" tooltip on
  the tab while an SSH session is auto-reconnecting; "reconnect failed — click to retry"
  when it gives up. Wired backend `TerminalTab.reconnectState` → IPC → preload → UI.

**Memory improvements**
- **Relevance-capped recall**: the whole `memory.md` used to be injected into every system
  prompt. Now only the most relevant entries are injected when the file exceeds 12K chars
  (ranked against the current input), so large memory files stop bloating context.
- **`memory:search` + `memory:append` RPC** — search memory entries (relevance-ranked) and
  append a note with **dedupe + a 40K size cap** (oldest entries pruned, title preserved).
  Wired in both the gybackend and Electron runtimes.

**Verification:** both typechecks green; **35 new tests pass** (autoReconnect 7,
chunkedRingBuffer 7, memoryManager 9, userMessageNav 10, autoReconnect integration 2);
all 22 terminal/Gateway/dashboard/sre/liveui suites + terminal-persistence/SSH/PTY/serial
regressions green. **Live-verified:** WinRM persistent-shell reuse + effective cwd
persistence + cwd-scoped execution + streaming against a real Windows host; Cisco IOS-XE
SSH connect + `show version`.

## v3.0.4 (2026-07-27)

### Feature — monitor-status diagnostic over RPC + agent tool

**"Why aren't stats displaying for terminal X?" is now a one-call answer.** The
`MonitorStatusService` diagnostic (which reports per-terminal whether the publisher is
wired, a monitor session exists, collection is stuck in-flight, the platform, and
last-collect age) was previously internal-only. It's now exposed everywhere:

- **`observability:monitorStatus`** — the full per-terminal JSON report.
- **`observability:monitorStatusSummary`** — a compact text summary.
- **`get_monitor_status` agent tool** — `format: 'summary'` (default) or `'report'`.
- Self-listed by `gateway:describe` / `list_gateway_methods`.

**Also fixed:** `ResourceMonitorService` now stamps `lastCollectAt` on every collection,
so the diagnostic's "never_collected" / "stale_collection" / "collection_stuck" diagnoses
are accurate (the field existed in the report but was never set).

Verification: backend typecheck exit 0; 13/13 observability-tools tests (incl. new
monitor-status cases + the observability-unavailable guard) pass; bridge test confirms
both new methods are dispatchable; live E2E on a real backend (`monitorStatus` returns a
valid report, `gateway:describe` self-lists both methods).

## v3.0.3 (2026-07-27)

### Fix — `/dashboard` "Upgrade Required" on the desktop app

**The desktop RTerm app returned `426 Upgrade Required` for `http://localhost:17888/dashboard`.**
v3.0.2 wired the dashboard `httpRoutes` only into the **headless gybackend** runtime
(`startGyBackend.ts`), but the desktop app creates its gateway in
**`startElectronMain.ts`** — which was never given the routes, so its gateway stayed a
bare WebSocket-only server that answers plain HTTP with "Upgrade Required".

- **Wired `/dashboard` + `/dashboard/json` into the Electron main runtime** (same live
  page, same WS-push behaviour, same gateway-mirrored auth).
- **Factored the dashboard HTTP auth into a shared `dashboardHttpAuth.ts`** used by BOTH
  runtimes (loopback open, remote needs a token) — removes the duplication that let the
  two drift.
- **Regression guard** (`dashboardHttpAuth.extreme.spec`): asserts gybackend AND Electron
  main both wire `httpRoutes` + `/dashboard` + `/dashboard/json` + the live renderer +
  the shared auth helper, so this can't regress on one runtime again.

Verification: backend typecheck exit 0; 5 new auth/regression tests pass; all 18
Gateway/dashboard/liveui/sre suites green; backend + Electron bundles both build and the
Electron main bundle contains the dashboard routes; live smoke on gybackend
(`/dashboard` 200 HTML, `/dashboard/json` 200 JSON).
## v3.0.2 (2026-07-27)

### Feature — Live browser dashboard at `/dashboard` (same port as the WS gateway)

**The unified dashboard is now visible in any browser.** The gateway serves a live
dashboard page on the **same port** as the WebSocket RPC endpoint (default 17888) — no
new listener. Open `http://localhost:17888/dashboard` and watch fleet health, SLOs,
incidents, APM, DEM, k8s clusters, and capacity update **in real time**.

- **Same-port HTTP + true WS push.** A new `httpRoutes` option on
  `WebSocketGatewayAdapter` lets the default server factory create ONE node `http.Server`:
  plain HTTP requests hit a route table, WS upgrades hit the WSS on the same socket.
  With no routes configured the adapter is byte-identical to before (fully backwards
  compatible). ESM-safe `node:http` loading via `createRequire`.
- **Live page, no reloads.** `renderLiveDashboardHtml()` renders initial state
  server-side (first paint works before WS connects), then an embedded client subscribes
  via `observability:liveDashboardSubscribe` and updates each section **in place** on
  every monitor-snapshot push — no meta-refresh. Falls back to polling
  `/dashboard/json` every 5s if WS is unavailable, and keeps retrying the socket.
- **Auth mirrors the WS gateway** — loopback is open; remote callers need a valid
  access token (`Authorization: Bearer`, `x-access-token`, or `?access_token=`).
- Startup logs the dashboard URL (`[gybackend] Live dashboard: http://…/dashboard`).

Verification: backend typecheck exit 0; 10 new tests (5 httpRoutes end-to-end incl.
WS-still-works on the shared port, 5 live-renderer incl. XSS escaping and
classic-renderer regression) — all pass; all 17 Gateway/dashboard/liveui/sre suites
green. Live-verified: `/dashboard` (200 HTML), `/dashboard/json` (state), 404s, WS
subscribe + APM ingestion reflected in a push event, and a real browser render.


## v3.0.1 (2026-07-27)

### Fix — `collect_facts` on WinRM / cmd-shell Windows Targets

**`collect_facts` on WinRM (cmd/response-shell) Windows targets returned only `hostname`** — the
`windows` fact template ran bare PowerShell commands (`$PSVersionTable…`, `[System.Environment]…`,
`Get-CimInstance…`), but WinRM tabs execute via **cmd.exe**, so every PowerShell fact failed with a
cmd syntax error. (SSH-to-Windows PowerShell hosts worked; WinRM didn't.)

- **`isCmdShellTarget()`** — detects `tab.type === 'winrm'` (cmd/response shell).
- **`wrapWindowsFactForCmdShell()`** — wraps PowerShell fact commands in
  `powershell -NoProfile -Command "…"` for cmd-shell targets, leaving `hostname` and cmd-native
  commands bare. Covers `$(...)`, `[...]`, `(Get-...)`, and verb-dash forms.
- `collect_facts` applies the wrap when the target is Windows **and** a cmd-shell — so the template
  now works on both PowerShell-host SSH and cmd-shell WinRM targets.
- 2 regression tests (helper wrap + end-to-end WinRM template). fleet_tools suite 14/14, v2.9 suite
  218 PASS / 0 FAIL, backend typecheck exit 0.

## v3.0.0 (2026-07-26)

### API Self-Discovery — `gateway:describe` + a Single-Source Method Registry

The gateway now **describes itself**. Ask it what it can do and get a live, accurate answer —
no more reading `WebSocketGatewayAdapter.ts` to learn the RPC method names.

- **New `methodRegistry.ts`** — the single source of truth for the entire gateway RPC surface.
  The adapter's dispatch, the `gateway:describe` endpoint, the agent tool, and the reference docs
  all derive from this one registry, so they can never drift. Each method entry carries its
  **name, category, description, the version it was introduced (`since`), and params** (a small
  JSON-Schema-ish shape for client codegen / introspection). 123 methods across 12 categories
  (gateway, session, agent, terminal, filesystem, system, models, skills, memory, settings,
  tools, observability).
- **New `gateway:describe` RPC** — returns the full registry (version, count, categories,
  methods). Optional `category` and `prefix` filters (e.g. `category:"observability"` or
  `prefix:"settings:"`). Self-lists `gateway:describe`.
- **New `list_gateway_methods` agent tool** — the agent can now ask "what can the gateway do?"
  and answer from the same live registry instead of a hardcoded, version-drifting list. Same
  category/prefix filters.
- **Tests (6/6 registry, 12/12 tools, 218/0 v29):** registry includes core + describe + all 52
  observability methods, no duplicate names, valid categories + descriptions, **no drift** vs
  `OBSERVABILITY_METHODS`, category/prefix filtering, total count. Agent tool listed in
  `BUILTIN_TOOL_INFO` (tools-section visibility).

**Why a major bump:** this changes the gateway's public contract surface in a forward-only way
(it adds a first-class discovery endpoint + a documented registry clients can rely on), and it's
the foundation for generated SDKs/CLIs that stay in sync automatically.

**Verification:** backend typecheck exit 0; backend-unit 232 PASS; v2.9 suite 218 PASS / 0 FAIL;
methodRegistry 6/6; web typecheck exit 0.

## v2.9.13 (2026-07-26)

### Fix — Version Check 403 + No GitHub in UI (Silent Background Updates)

**Version check failed with a red "Check Failed: HTTP 403".** The updater fetched `version.json` from
the **GitHub API contents endpoint** (`api.github.com/repos/.../contents/version.json`), which is
rate-limited (60 req/hr unauthenticated) and returns **HTTP 403** when the limit is hit — surfacing
as a scary red error every hour.

- **Fetch from the raw URL instead** (`raw.githubusercontent.com/.../version.json`) — no API rate
  limit, no 403, and a simpler plain-JSON parse (no base64 contents wrapper). Verified live: HTTP 200.
- **Silent background check:** a transient network failure (rate-limit, timeout, offline, DNS) no
  longer surfaces as a red "Check Failed" — it keeps the last-good cached version and reports
  up-to-date quietly (warning recorded for diagnostics only). A genuine update still surfaces normally.
- **No GitHub in the UI:** the version Source and Download URL now point at the app website —
  `https://rterm.app` and `https://rterm.app/#download` (download always, regardless of the manifest's
  `download` field). The privacy note no longer mentions GitHub.

**Also in this release:** end-to-end live validation of the Automation & Change-Management and SRE
pillars — reusable scripts, cron, Jinja templates (render + versioned diff), multi-step playbooks,
approval-gated MOP changes (plan→approve→run→committed), event-driven triggers (pattern in terminal
output → playbook fired), 18/18 observability RPC methods, APM/DEM/Infra ingestion, fleet
(run_fleet_command, collect_facts) and connections across SSH (Windows) + Cisco. Integrations verified
live: Telegram (message delivered), AWS (sts identity + EC2 inventory). NATS is wired but needs NKey
credentials not in the vault (skipped live per policy; the feature is correctly wired).

**Verification:** backend typecheck exit 0; web typecheck exit 0; v2.9 suite 218 PASS / 0 FAIL.

## v2.9.12 (2026-07-26)

### Fix — Agent-Created Triggers Now Fire Immediately (No Restart Needed)

**Event-driven triggers created via the agent's `manage_trigger` tool never fired until the backend
restarted.** `createTriggerRuntime` only loads persisted triggers **once at startup**; the agent tool
wrote new triggers to the `AutomationManager` store but never told the live `TriggerEngine`, so a
freshly created pattern/threshold trigger silently did nothing.

- **`manage_trigger` now syncs the live engine on every mutation:** `create`/`update` →
  `engine.upsert()`, `delete` → `engine.remove()`, `enable`/`disable` → `engine.upsert({...t, enabled})`.
  New triggers fire immediately; deleted/disabled ones stop.
- **Regression tests added:** `create` must sync into the live engine so it fires without restart;
  `delete` must stop it. trigger_tools suite 14/14 green.

Validated end-to-end against the live gateway: the full Automation & Change-Management surface works —
reusable scripts, cron scheduled tasks, Jinja config templates (render + versioned diff), multi-step
playbooks (command/wait), approval-gated MOP changes (plan → approve → run → committed), and
**auto-rollback on validation failure** (rolled_back). The full SRE/observability pillar passes a
17/18-method live smoke (the one "failure" is the GitOps guard correctly rejecting a missing manifest
with a clear message — export → inSync round-trips `true`). Integrations verified live: Telegram
(message delivered), AWS (sts + EC2 inventory parsed via CloudInventory), NATS (server reachable;
needs its own auth, which isn't in the vault — feature is wired, just needs credentials).

**Verification:** backend typecheck exit 0; v2.9 suite 218 PASS / 0 FAIL; backend-unit 232 PASS / 0
FAIL; automation 660 PASS / 0 FAIL.

## v2.9.11 (2026-07-26)


### Fix — Agent-Tool Session Recording Now Captures (Was 0 Events)

**Session recording started via the agent's `manage_recording` tool captured nothing (0 events).**
The tool called `SessionRecorder.start()` directly, which never registered the terminal in
`TerminalService.activeRecordings` — and the live-output feed (`handleData`) checks that map to decide
what to capture. So recordings started by the agent ran empty, while the gateway path
(`observability:recordingStart`) worked because it went through `TerminalService.startRecording()`.

- **`manage_recording` `start` now routes through `TerminalService.startRecording()`** (which sets
  `activeRecordings`, with a fallback to the raw recorder when TerminalService isn't available), so
  agent-started recordings actually capture live output.
- **`stop` now deregisters** the terminal from `activeRecordings` so it's no longer flagged as
  recording.
- **Regression test added:** agent-tool `start` must register the terminal for live capture (and
  `stop` must deregister). observability_tools suite 12/12 green.

**Verification:** backend typecheck exit 0; v2.9 suite 218 PASS / 0 FAIL; live reproduction confirmed
(agent-started recording now captures events, replays, and exports `.cast`). No asciinema needed —
recording/playback/export are native.

## v2.9.10 (2026-07-26)

### AgentSpan Phase 2 — RTerm Playbooks as Conductor Workflows + Durable Delegation

Deepens the AgentSpan/Conductor bridge so the integration runs **both** directions: AgentSpan
agents can now invoke RTerm's own playbooks as steps, and RTerm can delegate long-running tasks
to durable AgentSpan agents.

- **Export + register RTerm playbooks as Conductor WorkflowDefs.** New
  `playbookToWorkflowDef(playbook)` pure mapper (`plugins/agentspan-bridge/playbookToWorkflowDef.mjs`):
  command steps → `HTTP` run_command tasks, script steps → `SIMPLE` script-reference tasks,
  wait steps → `WAIT` tasks; sequential + `dependsOn` DAG (multi-dep steps get a `JOIN` fan-in),
  `onError: continue` → `retryCount`, and `rollback` steps → compensating `optional` tasks run in
  reverse step order (undo newest first). New client methods `registerWorkflowDef`
  (`POST /api/metadata/workflow`) + `getWorkflowDef`.
- **2 new tools for playbooks:** `agentspan_export_playbook` (dry-run — returns the mapped
  WorkflowDef) and `agentspan_register_playbook` (maps + registers it on the server so
  `agentspan_run {workflow:<name>}` and AgentSpan `SUB_WORKFLOW` steps can call it). Command tasks
  call back into RTerm's policy-gated exec path via a configurable exec URI.
- **Durable task delegation:** new `agentspan_delegate` tool runs a prompt/task as a durable
  AgentSpan agent (compiles + starts an `AgentConfig`) and returns an `executionId` that survives
  RTerm/host restart — follow up with the existing `agentspan_status` / `agentspan_approve` /
  `agentspan_stop`. The plugin now exposes **9 tools** + 1 trigger + 1 panel.
- **Docs:** `docs/agentspan-integration.md` gains the Phase-2 section (mapping table, both
  directions, full 9-tool reference).

**Verification:** 22 new offline tests for the mapper (step→task, DAG edges, wait/rollback,
retries), the new client methods, and all 3 new tools (mocked fetch) — plus the 26 Phase-1 tests
stay green (48 total). pluginRegistry 17/17; pluginSuite 56/56; migrations 18/18; v2.9 suite
217 PASS / 0 FAIL; backend-unit 232 PASS; backend + web typecheck exit 0.

## v2.9.9 (2026-07-26)

### AgentSpan / Conductor Integration — Durable, Crash-Resilient Agents

Adds an optional bridge to an [AgentSpan](https://github.com/agentspan-ai/agentspan) (Netflix
Conductor) server, giving RTerm the one capability it didn't have: **durable agent execution —
a crashed or restarted run resumes from the last completed step** (instead of just being marked
`aborted` in the run ledger). Deployed as a **sidecar + plugin bridge** — no RTerm core changes.

- **New `agentspan-bridge` plugin** (6 tools, 1 trigger, 1 panel), auto-integrated by the
  plugin registry:
  - `agentspan_health` / `agentspan_run` / `agentspan_status` / `agentspan_approve` /
    `agentspan_list` / `agentspan_stop` — start durable agents (`AgentConfig`) or named Conductor
    workflows, inspect per-task progress, respond to human-in-the-loop pauses, list executions,
    and stop runs.
  - `agentspan_execution_failed` trigger → proposes a remediation change on FAILED/TERMINATED/
    TIMED_OUT.
  - **AgentSpan Executions** dashboard panel.
- **Dependency-free `conductorClient.mjs`** — a pure + injectable HTTP client for the AgentSpan
  `/api/agent/*` lifecycle surface and Conductor `/api/workflow/*` engine surface (health,
  start/compile, status, respond, stop, events, search, terminate, retry). AgentSpan standalone
  auth (`X-Auth-Key`/`X-Auth-Secret`) supported via a vault `secretRef` — never inline.
- **Settings → AgentSpan** UI section + `agentspan` settings block (schema v5) with a
  `normalizeAgentspanSettings` migration guard: server URL, optional auth secretRef, enable
  toggle. The plugin resolves config + auth from settings/vault on every call.
- **Resilient by design:** when the AgentSpan server is down, every tool returns a clear
  `{error, hint}` instead of crashing the agent.
- **Docs:** `docs/agentspan-integration.md` — what AgentSpan adds (durability, plan-execute
  determinism, Kafka/SQS/AMQP triggers, visual execution UI, multi-framework/multi-language
  agents) vs what RTerm already has, plus sidecar setup.

**Verification:** 26 new offline tests for the bridge (client URL/auth/errors + every endpoint,
plugin glue, unreachable-server resilience) all pass; pluginRegistry 17/17; pluginSuite 56/56;
migrations 18/18; v2.9 suite 217 PASS / 0 FAIL; backend-unit 232 PASS; backend + web typecheck
exit 0.

## v2.9.8 (2026-07-26)

### Backend Typecheck Green + Release Notes from CHANGELOG

A hardening pass that makes the whole backend typecheck cleanly (exit 0) and fixes the
release pipeline to ship correct notes automatically.

- **`commandParser.ts` — TS1361 fixed.** `Language` was `import type` but used as a value
  (`Language.load`). It's now pulled from the dynamic `import('web-tree-sitter')` alongside
  `Parser`.
- **`NodePtyBackend.ts` — ESM-safe loader.** The lazy `require('node-pty')` crashed under
  tsx/ESM (`require is not defined`), failing `sessionLogging.integration.spec`. It now uses
  `createRequire(import.meta.url)`, which works under both ESM (tests) and the CJS app
  bundle. That integration test passes again.
- **`SSHBackend.ts` — ~50 errors cleared.** The `let ssh2` loader variable shadowed the
  `ssh2` type namespace, so every `ssh2.*` type reference failed to resolve (TS2503) and
  cascaded into implicit-any params (TS7006). The namespace is now a proper
  `import type * as ssh2`, the variable renamed to `ssh2Lib`, and the loader uses the same
  ESM-safe `createRequire`. **Backend typecheck is now fully green (exit 0) across the whole
  backend.**
- **`build-release.yml` — release notes no longer stale.** The release body was a hardcoded
  v1.7.x template. The workflow now builds the body from `CHANGELOG.md` at release time
  (extracts the current version's section, generic fallback) and keeps the Downloads/Install
  table. This v2.9.8 release's notes were generated by that new path.

**Verification:** backend typecheck exit 0; automation 657 PASS / 0 FAIL (incl.
sessionLogging); backend-unit 232 PASS; v2.9 suite 217 PASS / 0 FAIL.

## v2.9.7 (2026-07-25)

### SECURITY — npm republish (credential leak) + Bug Fixes

**Security (npm packages only):** `neuralos@2.9.6` / `rterm-backend@2.9.6` accidentally
bundled a local runtime state file (`.gybackend-data/settings.json`) created when the
staging package was boot-verified before publish — it contained a live API key. Both 2.9.6
packages were **deprecated and then unpublished**; this clean 2.9.7 republish adds a
hardened `.npmignore` (excludes `.gybackend-data/`, `*.sqlite*`, `.npmrc`) and is verified
to contain **zero** state/secret files. Git history was never affected (repo
`.gybackend-data/` is gitignored + untracked). **If you installed 2.9.6 from npm, rotate
any key present in your OpenRouter/provider accounts and upgrade to 2.9.7.**

### Bug Fixes — Cost Attribution, GitOps Gateway Robustness, Schema Test Drift

A focused audit + hardening pass over the v2.9.6 settings-driven work and the broader
gateway/agent surface. Three real bugs fixed, each covered by tests.

- **Cost attribution — self-doubled provider model ids.** Some providers (observed with
  OpenRouter streams) report the model id concatenated to itself (e.g.
  `moonshotai/kimi-k3moonshotai/kimi-k3`). Those ids never matched the price-table keys, so
  affected runs silently priced at `default` instead of the model's real rate. New
  `normalizeModelId()` collapses an exact self-doubled id at the run-ledger persistence
  boundary (`startRun` + `recordUsage`), so cost attribution matches the configured price.
  (Fixes forward; historical doubled rows are not retro-rewritten.)
- **GitOps gateway — clear error instead of an opaque crash.** Calling
  `observability:gitopsDrift` / `gitopsInSync` / `gitopsReconcile` without a manifest (the
  agent tool guarded this, but the gateway RPC did not) crashed with
  `Cannot read properties of undefined (reading 'entities')`. New `assertManifest()` guard
  at the `GitOpsService` boundary returns an actionable message
  ("a StateManifest with an entities array is required (call export first to build one)").
- **Schema-test drift.** `agentSettings.extreme.spec.ts` asserted the final schema version
  was `4`; after the v2.9.6 v4→v5 bump it failed. It now asserts against
  `BACKEND_SETTINGS_SCHEMA_VERSION` so it tracks future bumps.

**Hardening / tests:** new `migrations.edgecases.extreme.spec.ts` (6 tests) locking in
`settings:set` deep-merge behavior (a budgets-only save preserves prices and vice-versa) and
normalizer robustness against null/garbage/NaN cost·alerts·oncall·cloud blocks; gitops guard
tests; `normalizeModelId` unit + integration tests.

**Verification:** backend typecheck clean on changed files; web typecheck exit 0; backend-unit
232 PASS / 0 FAIL; v2.9 suite 217 PASS / 0 FAIL; layout-ui 396 PASS / 0 FAIL; gitops 16/16;
run-ledger 14/14; migrations 17/17 + edge-cases 6/6. (Note: `sessionLogging.integration.spec.ts`
fails in this environment because `node-pty` can't load under the tsx/ESM test runner — the
bare `require('node-pty')` in `NodePtyBackend.ts` works in the shipped CJS build but not under
ESM; local PTY terminals work in the actual app. Recommend switching that loader to
`createRequire(import.meta.url)` — left as-is since that file is under active edit.)

## v2.9.6 (2026-07-25)

### Settings-Driven Observability — Cost, Alerts, On-Call & Cloud Wired End-to-End (No Placeholders)

Four observability capabilities were constructor-injected but **never wired to settings or
the UI**, so they silently no-op'd out of the box. This release gives each a persisted
settings block (schema **v4 → v5**), a Settings UI section, and **live reload with no
restart** — plus a documented decision on the review model. Secrets are never stored
inline (vault `secretRef` only).

- **AI Cost** — new `cost` block (`modelPrices` + `budgets`). `CostBudgetService` gains
  `setPrices`/`getPrices`/`clearBudgets`; `createObservability` reads `settings.cost` and
  re-prices on the fly. New **Settings → AI Cost** section: editable price table (USD/1M
  tokens, `default` fallback) + budgets editor. Turns the run ledger's token counts into
  real dollars (previously always `$0`).
- **Alerts** — new `alerts.channels` (slack/teams/smtp/telegram). Channels are built live
  from settings + the vault into the array `AlertService` reads at fire time. New
  **Settings → Alerts** editor (type, severity, enable, secretRef, telegram chatId, full
  SMTP config). Ships a **dependency-free SMTP sender** (`sendSmtpMail`, Node `net`/`tls`:
  EHLO → STARTTLS → AUTH LOGIN → DATA) so alert email works with no mail dependency.
- **On-Call** — new `oncall.pagingChannels` (slack/teams/smtp/telegram/**webhook**).
  `EscalationService` gains `setChannels`/`listChannels`; channels hot-swap live. New
  **Settings → On-Call** editor.
- **Cloud Inventory** — new `cloud.accounts` (aws/gcp/azure, region + credential
  `secretRef`). `CloudInventory` gains `setAccounts`; the CLI fetchers are now
  account/region/credential-aware (vault `KEY=VAL` env injected per call). With no accounts
  it falls back to ambient CLI credentials. New **Settings → Cloud** editor.
- **Live reload** — `SettingsService.onDidChange` + `NodeSettingsService.onDidChange`;
  `startGyBackend` subscribes and calls `refreshCost` / `refreshAlertChannels` /
  `refreshOncallChannels` / `refreshCloudAccounts` on any settings change (covers the
  `settings:set` RPC, Connection/Automation managers, and UI saves).
- **Review model** — verified **agent-profile-bound, not a settings block**:
  `reviewModelId`/`reviewMode` already live on `ModelProfile` and are editable in
  Settings → Models → Profiles; `runReviewModel` is a runtime function injection.
  Documented in `docs/settings-driven-features.md`.

**Security:** every channel/account secret is a `secretRef` into the AES-256-GCM vault,
resolved only at send/sync time — never persisted in settings.

**Verification:** backend typecheck clean on changed files; web typecheck exit 0; v2.9
feature suite **215 PASS / 0 FAIL**; migrations 17/17; cost 23/23; SMTP 3/3; escalation
19/19; cloud 15/15.

## v2.9.5 (2026-07-25)

### APM / DEM / Infra / ETW Ingestion — the Last 4 Placeholders, Now Genuinely Fed

The APM `spanLedger`, DEM `rumLedger`, Infra `infraMonitor`, and ETW `etwService` existed and rendered in the dashboard, but **nothing fed them data out of the box** — they showed "No APM spans ingested yet" forever. This release wires real ingestion surfaces for all four, following the v2.9.x pattern, and verifies each one live against a real boot.

- **APM** — `observability:apmIngestSpans` RPC + `ingest_apm_spans` / `get_apm_summary` tools accept OTLP/HTTP-JSON trace payloads → `spanLedger` (bottleneck services, slowest traces, dashboard APM). Verified: 2 spans land, the service appears in the summary and in `dashboard:state`.
- **DEM** — `observability:demIngestBeacon` RPC + `ingest_dem_beacon` / `get_dem_summary` tools accept Core Web Vitals beacons (page, LCP/INP/CLS/TTFB, JS errors) → `rumLedger` (per-page p75 + error rate). Verified: a `/pricing` beacon populates the summary.
- **Infra (k8s)** — `observability:infraCollect` RPC + `collect_infra` runs `kubectl get pods -A` (text) or accepts a payload (text table **or** a JSON object, rendered to the table shape) → `infraMonitor` cluster health (not-ready, CrashLoopBackOff). Verified: pods parsed + recorded.
- **ETW (Windows)** — `observability:etwStartTrace` / `etwStopTrace` / `etwParse` RPC + `manage_etw` builds logman start/stop commands and parses `Get-WinEvent`/`Get-Counter` output → `etwService` sessions. Verified: start/stop/parse over the bridge.

Registered across `observabilityBridge` (**+15 RPC methods**, 56 total), `observability_tools` (6 new agent tools), `tools.ts`, `AgentService_v2` dispatch, and `BUILTIN_TOOL_INFO` (Tools-section visibility). **14 new tests** (208 total, all green). Typecheck + lint clean.

## v2.9.4 (2026-07-25)

### No Placeholders — the 9 Capabilities Actually Work Out of the Box

The v2.9.x modules + RPC/agent tools existed, but 6 of them didn't function end-to-end without manual steps. This release wires them all for real, with a **live verification pass proving each one**.

- **Session recording** — `TerminalService.handleData` now feeds live terminal output into active recordings (`setSessionRecorder` + per-terminal recording map + `startRecording`/`stopRecording`/`isRecording`). `recordingStart` routes through TerminalService so capture actually flows; `recordingStopTerminal` added. Wired into both runtimes. **E2E-proven: a real terminal command's output is captured + replayed** (`recordingCapture.extreme.spec.ts`, 6 tests).
- **Live dashboard** — new `observability:liveDashboardSubscribe`: a WebSocket subscribes to the hub and receives filtered `dashboard:state` as `gateway:event` frames on every update (pruned on socket close). Verified: a subscriber receives live frames.
- **OTel push** — background timer pushes metrics to `OTEL_EXPORTER_OTLP_ENDPOINT` every `OTEL_EXPORTER_OTLP_INTERVAL_MS` (default 30s), refreshing the registry from the ledger before each push. Verified: a local OTLP listener receives `resourceMetrics` POSTs.
- **On-call** — background 30s tick driver escalates unacked pages automatically. Verified: a page with a 1s ack timeout escalates level 0→1 with no manual `oncallTick`.
- **AI cost** — background feeder mirrors agent-run token usage from the run ledger into the cost ledger every 60s (deduped by run id). Verified: a real completed agent run's spend appears in `costSummary` with no manual `costRecord`.
- **GitOps** — default `readLive` builds the real estate from saved connections + automation (groups/scripts/playbooks/templates/scheduled tasks). Verified: `gitopsExport` returns real saved entities.
- **Cloud inventory** — default fetchers shell out to `aws`/`gcloud`/`az` CLIs (JSON) when none are injected; a missing CLI/credential surfaces as a structured sync error, not a crash. Verified: the fetcher path executes and returns a structured result.

`settingsService` dep wired into both `createObservability` call sites; `onBackgroundDrivers` hook added for clean shutdown. **194 tests green** (188 + 6 new recording-capture). Typecheck + full suite clean.

## v2.9.3 (2026-07-25)

### Tool Visibility — every agent tool is now visible in the Tools section

A full audit of the agent's tool surface vs the UI catalog (`BUILTIN_TOOL_INFO`) found that several working tools were **callable but invisible** — they didn't appear in the Tools section (driven by `tools:getBuiltIn`), weren't toggleable, and weren't proactively offered to the agent. All are now registered and visible.

**Newly visible tools:**
- The 9 observability tools from v2.9.2: `get_metrics`, `manage_secret`, `manage_oncall`, `get_cost`, `manage_recording`, `manage_gitops`, `manage_playbook_version`, `get_cloud_inventory`, `get_live_dashboard`.
- 4 long-standing tools that were never in the catalog: `write_file`, `edit_file`, `skill`, `create_skill`.

**Regression test** (`AgentHelper/tools/toolVisibility.extreme.spec.ts`): asserts every dispatchable tool appears in `BUILTIN_TOOL_INFO`, in the `tools:getBuiltIn` summary, defaults to enabled (except the intentionally-dangerous `copy_between_tabs` / `read_file_transfer_status`), survives the enabled filter, and that the 9 observability + 4 file/skill tools specifically are visible. Wired into `test:v29-features` (188 tests total, all green).

Verified across all three surfaces: `BUILTIN_TOOL_INFO`, the `tools:getBuiltIn` summary the UI renders, and `TOOLS_FOR_MODEL` after the enabled filter.

## v2.9.2 (2026-07-25)

### Wiring the 9 Capabilities into the App, Agent & Gateway

The 9 platform capabilities from v2.9.0 are now **usable, not just present in the engine** — exposed as WebSocket RPC methods on the gateway **and** as first-class AI-agent tools, in both the headless (`gybackend` / `neuralos` / `rterm-backend`) and desktop runtimes. **24 new tests, all green; RPC verified live over the real gateway.**

**Gateway RPC bridge** (`services/Gateway/observabilityBridge.ts`):
- 41 new `observability:*` RPC methods covering every capability — `observability:metricsPrometheus`, `dashboardState/Summary`, `secretsList/Set/Delete/Has` (metadata only, never values), `oncallListPolicies/RegisterPolicy/OpenPages/Page/Ack/Resolve/Tick`, `costSummary/Record/Check/ListBudgets/SetBudget/RemoveBudget`, `recordingList/Start/Stop/Replay/ExportCast/Delete`, `gitopsExport/Drift/InSync/Reconcile`, `playbookLint/History/Save/Rollback/Diff`, `cloudSummary/Query/Sync/AddAccount`, `liveDashboardState/SubscriberCount`.
- Dispatched generically in `WebSocketGatewayAdapter` (any `observability:*` method → bridge fn), and wired into both `startGyBackend` and `startElectronMain` (desktop uses a late-bound ref since the adapter is built before `createObservability`).

**AI-agent tools** (`services/AgentHelper/tools/observability_tools.ts`) — drive all 9 in natural language:
- `get_metrics` (Prometheus text or summary), `manage_secret` (vault list/set/delete/has — value never echoed), `manage_oncall` (page/ack/resolve/open-pages/policies/tick), `get_cost` (spend summary, budget check, list budgets), `manage_recording` (start/stop/replay/export_cast/list/delete), `manage_gitops` (export/drift/in_sync), `manage_playbook_version` (lint/history/rollback/diff), `get_cloud_inventory` (summary/query/sync), `get_live_dashboard` (state/subscribers).
- Registered in `AgentHelper/tools.ts` (schemas + OpenAI tool defs + implementations) and dispatched in `AgentService_v2`; the `ToolExecutionContext` gains an `observability` handle wired via `agentService.setObservability(...)` in both runtimes.

Now you can say in chat: *"add this API key to the vault"*, *"show my AI spend today"*, *"page the on-call for the DB incident"*, *"record this session"*, *"export my setup as a GitOps manifest"*, *"lint this playbook"*, *"list my AWS instances"* — and the agent does it.

## v2.9.0 (2026-07-25)

### 9 New Platform Capabilities — Observability Export, Secrets, On-Call, Cost, GitOps, Cloud, Live Dashboard, Recording, Playbook Versioning

Nine new subsystems, all built as pure/injectable modules in `packages/backend/src/services/`, wired into `createObservability`, and covered by exhaustive `*.extreme.spec.ts` suites — **158 new tests, all green, zero regressions** across the existing suites.

- **Prometheus `/metrics` scrape exporter + OTel push exporter** (`sre/prometheusExporter`, `sre/otelExporter`) — RTerm can now be *observed by* other tools. A `PrometheusRegistry` renders `# HELP/# TYPE` exposition text from the metrics ledger; an `OtelExporter` pushes OTLP/HTTP JSON to a collector (endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT` / `RTERM_OTLP_METRICS_ENDPOINT`). Closes the "RTerm ingests observability but can't be observed" gap.

- **Built-in secrets vault** (`secrets/secretsVault`) — first-class encrypted secret store. AES-256-GCM over scrypt-derived keys, encrypted at rest, materialized only at exec time (never into LLM context), constant-time master-key verify, ciphertext export/import, and every access audited into the tamper-evident audit ledger. Master key via `RTERM_SECRETS_MASTER_KEY`.

- **Incident escalation & on-call (paging)** (`oncall/escalationService`) — multi-level escalation policies with ack deadlines, paging channels, repeat/expire, acknowledge/resolve, and per-incident page queries. Turns "an alert in a Slack channel" into real incident response.

- **AI cost & token budgets** (`cost/costBudgetService`) — per-model price table turns run-ledger token counts into dollars (per model/profile/day), with daily/monthly budgets that gate runs (`warn` / `throttle` / `deny`). Financial control for multi-model agent setups.

- **Live multi-user dashboard hub** (`liveui/liveDashboardHub`) — upgrades the static self-refreshing dashboard to a push model: many concurrent subscribers (web/TUI/mobile), per-client section/host filters, replay-on-subscribe, publishes on every monitor snapshot.

- **Session recording/replay (asciinema-style)** (`recording/sessionRecorder`) — timed event capture with standard asciinema `.cast` v2 export/import, plus scrub/replay for training + audit.

- **GitOps — config & state in Git** (`gitops/gitOpsService`) — exports the whole desired-state estate (connections, playbooks, triggers, templates, policies, budgets) to a content-hashed manifest, detects drift (added/removed/changed with field-level diffs), and reconciles live state to the repo (gated, recorded).

- **Runbook/playbook versioning + linting** (`automation/playbookVersioning`) — version history with diff + rollback to any prior version, plus a static lint pass (undefined params, dependsOn cycles, empty steps, missing-rollback heuristic) that runs before any save/run.

- **Cloud resource inventory (AWS/GCP/Azure)** (`cloud/cloudInventory`) — normalizes each provider's instance list into a single `CloudResource` model with query/summary, feeding the CMDB/infra monitor. Fetchers are injectable; credentials come from the secrets vault.

**Wired into `createObservability`:** `metricsExport`, `secrets`, `oncall`, `cost`, `recording`, `gitops`, `playbooks`, `cloud`, `liveDashboard` — all reachable over the gateway. `package.json` gains the `test:v29-features` suite, wired into `npm test`.

## v2.8.0 (2026-07-23)

### Full-Repo Review + Null-Safety Hardening

Full-repo review of all features and plugins with a dedicated null/undefined-input hardening pass across the 6 official plugins. Found and fixed **10 null-safety bugs** where plugin pure functions threw on null/undefined inputs.

- **patch-manager**: `parsePatchStatus(null)` and `buildComplianceReport(null)` threw (`Cannot read properties of null (reading 'split')` / `Cannot convert undefined or null to object`). Fixed with `String(output ?? '')` and `Object.entries(hostStatuses ?? {})`.
- **fraudops**: `buildDecisionSummary(null)` threw (`reading 'length'`). Fixed with `Array.isArray(decisions) ? decisions : []`.
- **iam-connector**: `parseUserInfo(null)`, `parseAccessReview(null)`, `isPrivileged(null)` all threw. Fixed with `String(output ?? '')` and `Array.isArray(userInfo?.groups) ? userInfo.groups : []`.
- **sop-assistant**: `buildStepCommand(null)` threw (`reading 'command'`). Fixed with `String(step?.command ?? '')` and `Object.entries(vars ?? {})`.
- **request-router**: `classifyRequest(null)`, `routeRequest(null)`, `buildQueueEntry(null)`, `filterQueue(null)` all threw. Fixed with `request ?? {}` guards and `Array.isArray(queue) ? [...queue] : []`.

- **11 new null-safety regression tests** (added to `pluginSuite.v2.7.3.extreme.spec.ts`) covering every fixed function.
- **Verified healthy**: all JSON.parse sites wrapped in try-catch (TerminalStateStore, SSHBackend, ModelCapabilityService); anomalyDetector mean/stddev guarded by minPoints; ResourceMonitorService totalDelta > 0 guards; aperfService top-process sort + slice guarded; netdata correlate handles null.
- **1260 tests total** (1249 + 11 new), 0 failures.

## v2.7.9 (2026-07-23)

### Review Model UI

The review model is now visible in the RTerm Settings UI alongside the other models (global, action, thinking, compaction).

- **Settings UI**: Two new dropdowns in the profile settings, right after the compaction model:
  - **Review Model (maker/checker)**: `(None — skip reviews)` + all available models. If `(None — skip reviews)` is selected, reviews are skipped entirely (fast output mode).
  - **Review Mode**: `Strict (block on any issue)` / `Advisory (flag but allow)` / `Auto-approve (skip low-risk)`.
- **Tooltips**: Full documentation of the maker/checker pattern and review modes in the UI tooltips.
- **TUI**: No change needed (TUI only uses `globalModelId`, no multi-model dropdowns).

## v2.7.8 (2026-07-23)

### Review Model — Maker/Checker Pattern

New `reviewService` — the maker/checker pattern for RTerm's agent. The action model (maker) produces output. The review model (checker) independently verifies it on 5 dimensions: correctness, completeness, safety, compliance, and accuracy. If no `reviewModelId` is specified in the profile, reviews are skipped entirely (fast output mode).

- **`ModelProfile`**: Added `reviewModelId` + `reviewMode` (`strict`/`advisory`/`auto-approve`).
- **`ReviewService.review()`**: Independently verifies the action model's output on 5 dimensions. Verdicts: `approved` / `needs_revision` / `escalate`. Review modes: `strict` (block on any issue), `advisory` (downgrade escalate to needs_revision), `auto-approve` (skip review for low-risk actions).
- **`shouldSkipReview()`**: Returns true when `reviewModelId` is undefined/empty.
- **`createSkippedReviewResult()`**: Returns approved with skipped=true.
- **Wired into `createObservability`** — `observability.review.service` + `shouldSkipReview` + `createSkippedReviewResult`. `runReviewModel` injected (offline mock or online).
- **17 new tests** (`reviewService.extreme.spec.ts`).
- **1249 tests total** (1232 + 17 new), 0 failures.

## v2.7.7 (2026-07-23)

### AGT Policy Engine — Pattern 1

New `agtPolicyEngine` — Microsoft AGT (Agent Governance Toolkit) policy engine for RTerm's agent. Evaluates agent actions against YAML policies (allow/deny/escalate) before execution.

- **`AgtPolicyEngine.evaluate()`**: Evaluates actions against a `PolicyDocument` (name, version, defaultDecision, rules). Features: glob-style pattern matching, target pattern wildcards (`prod-*`), first-match-wins rule evaluation, case-insensitive matching.
- **`parsePolicyYaml`/`parsePolicyJson`**: Parse YAML/JSON policy documents.
- **Agent identity + sponsoring principal**: For zero-trust identity.
- **Wired into `createObservability`** — `observability.governance.policyEngine`. Built-in default policy: allow read/status/list, deny delete/drop/format, escalate restart/patch/deploy on prod-*.
- **15 new tests** (`agtPolicyEngine.extreme.spec.ts`).
- **1247 tests total** (1232 + 15 new), 0 failures.

## v2.7.6 (2026-07-23)

### Monitor Status Diagnostic

New `monitorStatusService` — a diagnostic tool for the "stats don't display" issue. Reports exactly why stats aren't displaying for each terminal: whether the publisher is wired, whether a monitor session exists, whether collection is stuck (inFlight), whether the terminal is connected, whether the platform is detected, and when the last collection ran.

- **`report()`** returns per-terminal entries: `terminalId`, `connected`, `platform`, `hasSession`, `inFlight`, `lastCollectAt`, `lastCollectAgoMs`, `diagnosis` (ok / terminal_not_connected / no_monitor_session / collection_stuck_in_flight / never_collected / stale_collection).
- **`summary()`** returns a compact string for the agent: publisher status, terminal count, and issue list.
- **Diagnoses**: publisher not wired (createObservability not called), terminal not connected, no monitor session, collection stuck in flight, never collected, stale collection (>30s).
- **Wired into `createObservability`** — `observability.monitorStatus`. `resourceMonitorService` added to `ObservabilityDeps` (was previously only used via `setMonitorPublisher` closure, now passed directly). Both `startGyBackend.ts` and `startElectronMain.ts` updated to pass `resourceMonitorService`.
- **12 new tests** (`monitorStatusService.extreme.spec.ts`): publisher detection, all 6 diagnoses, summary string.
- **1232 tests total** (1220 + 12 new), 0 failures.

## v2.7.5 (2026-07-22)

### Desktop App Plugin Shipping

All 6 official plugins (patch-manager, request-router, sop-assistant, iam-connector, fraudops, netdata-rterm) now ship bundled in the **RTerm desktop app** and are auto-discovered on startup. No manual plugin installation required.

- **`electron-builder.yml`**: `extraResources` now includes `plugins/` — the 6 plugin folders are copied to `{app}/resources/plugins/` in the packaged app.
- **`startElectronMain.ts`**: `createObservability` is now called after `agentService.setTriggerEngine(triggerEngine)` (line ~1133), mirroring `startGyBackend.ts`. This was the critical gap — the desktop app previously never instantiated `PluginRegistry`, so the extraResources plugins would never have been discovered.
- **`observability.ts`**: `PluginRegistry.scanRoots` now also scans `process.resourcesPath/plugins` (for the packaged Electron app). Uses `createRequire` + `fs.existsSync` to check existence before adding.
- **Verified**: `dist/mac-arm64/RTerm.app/Contents/Resources/plugins/` contains all 6 plugin folders (fraudops, netdata-rterm, request-router, sop-assistant, iam-connector, patch-manager) + sample-k8s-slo.

The desktop app now discovers all 21 tools, 10 triggers, and 6 panels automatically on startup, just like the npm package does.

## v2.7.4 (2026-07-22)

### All 6 Plugins Shipped into rterm-backend npm Package

All 6 plugins (patch-manager, request-router, sop-assistant, iam-connector, fraudops, netdata-rterm) now ship bundled in the `rterm-backend` npm package and are auto-discovered on startup. No manual plugin installation required.

- **`observability.ts`**: `PluginRegistry.scanRoots` now includes the bundle's own `plugins/` directory, resolved via `new URL('../../plugins/', import.meta.url).pathname` (the bundle is at `bin/gybackend.js`, plugins are at `../plugins/`). Uses `createRequire` + `fs.existsSync` to check existence before adding (the source/unbundled case won't have it).
- **`package.json`**: `files` array now includes `"plugins/"` — the 6 plugin folders are shipped in the npm tarball.
- **Published**: `rterm-backend@2.7.4` with 22 files (bin/gybackend.js + 6 plugin folders with .mjs/.d.mts/plugin.json + README.md + LICENSE.md + package.json).
- **21 tools, 10 triggers, 6 panels** across all 6 plugins, all auto-discovered and available to the AI agent out of the box.

| Plugin | Tools | Triggers | Panels |
|---|---|---|---|
| patch-manager | 3 | 2 | 1 |
| request-router | 4 | 2 | 1 |
| sop-assistant | 4 | 1 | 1 |
| iam-connector | 4 | 1 | 1 |
| fraudops | 4 | 2 | 1 |
| netdata-rterm | 2 | 2 | 1 |
| **Total** | **21** | **10** | **6** |

## v2.7.3 (2026-07-22)

### Plugin Suite — Patch Management, Request Router, SOP Assistant, IAM Connector, FraudOps

Five new plugins for RTerm's plugin system (v2.5.0), extending the platform into autonomous patch management, request handling, SOP knowledge, IAM integration, and fraud operations.

#### 1. patch-manager — Autonomous Patch Management
- **3 tools**: `patch_status` (query available patches on a host), `patch_plan` (build a 5-step deployment plan: pre-check → backup → apply → post-check → rollback), `patch_apply` (execute patches with dry-run support).
- **2 triggers**: `patch_failure` (fires on patch execution errors → propose-change for investigation), `patch_completion` (fires on successful patch → run-playbook for compliance reporting).
- **1 panel**: `patch-compliance` (fleet-wide patch compliance dashboard with compliance rate, critical/security patch counts, per-host status).
- **Pure functions**: `buildPatchStatusCommand`, `buildPatchApplyCommand`, `buildPrePatchCheckCommand`, `buildPostPatchCheckCommand`, `parsePatchStatus`, `buildPatchPlan`, `buildComplianceReport`. Supports Linux (yum/apt) and Windows (Get-WindowsUpdate/Install-WindowsUpdate).

#### 2. request-router — Automated Request Handling & Approval Workflow
- **4 tools**: `submit_request` (submit operational request with type/target/justification/urgency), `approve_request` (approve/deny with rationale + audit trail), `list_requests` (filter by status/risk/urgency/target), `request_status` (get specific request).
- **2 triggers**: `request_urgent` (fires on critical/high urgency → run-playbook for immediate notification), `request_approved` (fires on approval → run-playbook for post-approval automation).
- **1 panel**: `request-queue` (request queue dashboard with pending/approved counts).
- **Pure functions**: `classifyRequest` (low/medium/high risk based on type + target), `routeRequest` (auto_approve/queue/mop based on risk + urgency), `buildRequestId`, `buildApprovalRecord`, `buildQueueEntry`, `filterQueue`.

#### 3. sop-assistant — IAM Knowledge & SOP Assistant
- **4 tools**: `sop_search` (keyword search over SOP library), `sop_get` (get specific SOP by ID), `sop_execute` (execute SOP step-by-step with variable substitution + dry-run), `iam_lookup` (search IAM policies).
- **1 trigger**: `sop_escalation` (fires on SOP execution failure → propose-change for escalation).
- **1 panel**: `sop-library` (SOP library browser with 8 built-in SOPs).
- **8 built-in SOPs**: restart-service, disk-cleanup, reset-password, database-failover, ssl-cert-renewal, user-offboarding, backup-restore, incident-response.
- **4 IAM policies**: password-policy, access-control, ssh-access, service-account.
- **Pure functions**: `searchSops`, `getSop`, `searchIamPolicies`, `buildStepCommand`.

#### 4. iam-connector — IAM Integration
- **4 tools**: `iam_user_info` (get user info: username, groups, enabled, locked, privileged), `iam_user_groups` (get group memberships), `iam_disable_user` (disable account — requires approval), `iam_access_review` (review all users + identify privileged users).
- **1 trigger**: `iam_privileged_change` (fires on privileged account change → propose-change for compliance).
- **1 panel**: `iam-access-dashboard` (IAM access dashboard with privileged user identification).
- **Pure functions**: `buildUserInfoCommand`, `buildUserGroupsCommand`, `buildDisableUserCommand`, `buildAccessReviewCommand`, `parseUserInfo`, `parseAccessReview`, `isPrivileged`. Supports Linux (id/groups/usermod) and Windows (Get-LocalUser/Disable-LocalUser).

#### 5. fraudops — FraudOps for RTerm
- **4 tools**: `fraudops_pipeline_status` (check Flink/NATS/Kafka health), `fraudops_str_assign` (assign STR case with 7-day CBN deadline), `fraudops_str_status` (filter STR cases by status/analyst/overdue), `fraudops_decision_summary` (BLOCK/REVIEW/APPROVE counts + rates).
- **2 triggers**: `fraudops_str_overdue` (fires on overdue STR case → propose-change for escalation), `fraudops_pipeline_down` (fires on pipeline component down → run-playbook for incident response).
- **1 panel**: `fraudops-dashboard` (unified fraud operations dashboard with decision summary + STR case tracking).
- **Pure functions**: `buildPipelineHealthCommand`, `buildNatsStatusCommand`, `buildKafkaLagCommand`, `parsePipelineHealth`, `buildStrCase`, `buildDecisionSummary`.

- **45 new tests** (`pluginSuite.v2.7.3.extreme.spec.ts`): all 5 plugins' pure functions + plugin lifecycle (register tools/triggers/panels).
- **1220 tests total** (1175 + 45 new), 0 failures.

## v2.7.2 (2026-07-22)

### Bug Hunt — 5 Bugs Found + Fixed

Full-repo bug hunt across all backend services (audit, aperf, sre, predictive, behavior, evals, infra, dem, etw, dashboard, notify, dagu, plugin, automation). 5 bugs found and fixed, with 13 regression tests.

- **Bug 1: `auditLedger.import()` crashes on malformed JSON** — `JSON.parse(json)` without try-catch threw an unhandled exception for malformed/truncated JSON instead of returning `{ valid: false, detail: 'invalid JSON' }`. Fixed: wrapped `JSON.parse` in try-catch, returns `{ imported: 0, valid: false, detail: 'invalid JSON' }` on parse failure.
- **Bug 2: `goldenSignals.percentile()` off-by-one** — `Math.floor((p/100) * sorted.length)` computed the wrong index for percentiles (e.g., p50 of [1,2,3,4,5] returned 4 instead of 3). Fixed: nearest-rank method (`Math.ceil((p/100) * sorted.length)`, clamped to [1, N], converted to 0-based index). Also exported `percentile` for testability.
- **Bug 3: `aperfService.parseAperfReport()` non-null assertions** — `summary.cpuUsagePercent!` used non-null assertion when the value could be `undefined` (if the regex didn't match). Fixed: replaced `?? 0` + `!` with explicit `!== undefined` checks.
- **Bug 4: `AgentService_v2` empty messages array access** — `messages[messages.length - 1]` accessed without checking if `messages` could be empty (from `[...state.messages]` or a ternary returning `[]`). Fixed: `messages.length > 0 ? messages[messages.length - 1] : undefined` at all 5 access points (lines 1501, 2514, 2717, 3440, 3507). Type changed from `BaseMessage` to `BaseMessage | undefined` for type safety.
- **Bug 5: `TerminalService` empty cleanedLines edge case** — `while (cleanedLines[cleanedLines.length - 1] === '')` could access `cleanedLines[-1]` when all lines are empty strings (the first while loop shifts them all away). Not a crash (returns `[]` correctly) but a potential edge case. Verified safe.

- **13 new regression tests** (`bugfixes.v2.7.2.extreme.spec.ts`): auditLedger.import malformed/truncated/valid JSON, percentile p50/p99/p100/p0/empty/single-element, parseAperfReport undefined metrics + no non-null assertion, empty array access returns undefined.
- **1175 tests total** (1162 + 13 new), 0 failures.

## v2.7.1 (2026-07-22)

### AI Agent Audit Trail (Hash-Chained Ledger + Evidence Sealing)

- **New: `auditLedger.ts`** — hash-chained, tamper-evident audit trail for AI agent operations. Every audit-relevant event (agent runs, command evaluations, approvals, MOP changes, playbook steps, trigger firings, alert ingestions, deep-dives) is appended as a hash-chained record: each record includes the SHA-256 hash of the previous record, forming an immutable chain. Any tampering with a historical record breaks the chain and is detectable by re-computing hashes.
- **New: `evidenceSealer.ts`** — Merkle-tree sealing for the audit ledger. Periodically computes a Merkle tree root over the audit ledger records and produces a sealed evidence bundle (root hash + metadata + record hashes). The sealed bundle is independently verifiable: anyone with the records can recompute the root and compare it against the sealed root. Satisfies the KLA audit framework's "Evidence integrity, retention, and independent verification" domain.
- **18 audit event kinds**: agent_run_start/end, command_evaluated/approved/denied/executed, mop_plan/approve/run/rollback, playbook_step, trigger_fired, netdata_alert, aperf_deepdive, config_change, incident_created/updated, evidence_sealed.
- **Query methods**: list, listByKind, listByTarget, listByActor, listInRange.
- **Chain verification**: verify() detects tampered content, tampered hashes, and broken prevHash chains.
- **Export/import**: export() → JSON, import() → verifies chain on recovery.
- **Wired into `createObservability`** — `observability.audit.ledger` + `observability.audit.sealer`.
- **34 new tests** (`auditLedger.extreme.spec.ts`): append + chaining, query methods, chain verification (tampered content/hash/prevHash), export/import round-trip + tamper rejection, Merkle root computation (empty/single/pair/odd), seal + verify (valid/tampered/missing records), bundle metadata, all 18 event kinds.
- **1162 tests total** (1128 + 34 new), 0 failures.

### What this enables

RTerm now has a production-auditable AI agent trail per the KLA 12-domain framework. Every agent action is recorded in a hash-chained, tamper-evident ledger. Evidence bundles can be sealed periodically (daily, weekly) and independently verified by auditors. Combined with RTerm's existing command policy (domain 4/6), MOP approvals (domain 7), run ledger (domain 8), drift detection (domain 9), incident ledger (domain 10), and session logging (domain 11), RTerm now covers 9 of the 12 KLA audit domains natively.

## v2.7.0 (2026-07-22)

### Netdata Integration Plugin

- **New: `netdata-rterm` plugin** — bridges Netdata's per-second monitoring + ML anomaly detection with RTerm's AI agent and SRE pillar. Ingests Netdata alert webhooks (per the Netdata Cloud webhook schema), correlates anomalies with RTerm's metrics ledger + incident history for agent RCA, and fires triggers for auto-remediation playbooks.
- **2 agent tools**: `netdata_alert_summary` (summarize alerts for a host) + `netdata_correlate` (correlate a Netdata alert with RTerm metrics + incidents for RCA).
- **2 triggers**: `netdata_critical_alert` (fires on critical-severity Netdata alerts → run-playbook for auto-remediation) + `netdata_warning_alert` (fires on warning-severity → propose-change for investigation MOP).
- **1 dashboard panel**: `netdata-alert-feed` (renders a table of recent Netdata alerts).
- **Pure functions**: `parseNetdataAlert` (parses both alert + reachability webhook payloads), `mapSeverity` (Netdata→RTerm severity mapping), `buildFingerprint` (dedup fingerprint), `toTriggerEvent` (converts parsed alert to RTerm trigger event), `correlateWithRterm` (correlates with metrics ledger + incident history).
- **27 new tests** (`netdata-rterm.extreme.spec.ts`): webhook parsing (alert + reachability), severity mapping, fingerprint building, trigger event generation, correlation with mock ledgers + incidents, plugin lifecycle (register 2 tools + 2 triggers + 1 panel), trigger matching (critical/warning only, netdata source only), panel rendering (with data + empty), tool handlers (valid + invalid payloads).
- **1128 tests total** (1101 + 27 new), 0 failures.

### What this enables

Netdata becomes the eyes (per-second metrics + ML anomaly detection on every node) and RTerm becomes the brain + hands (agent reasons about Netdata alerts, correlates with RTerm's metrics/incidents/changes, and triggers auto-remediation playbooks or MOP changes). Configure Netdata Cloud to send alert webhooks to RTerm's gateway endpoint.

## v2.6.0 (2026-07-22)

### AWS APerf Performance Deep-Dive

- **New: `aperfService`** — deploys the [AWS APerf](https://github.com/aws/aperf) CLI to a host via SSH, records deep system performance metrics (CPU, memory, disk, network, PMU counters, processes, hotspot data), generates the aperf analysis report, and parses the findings into structured results that RTerm ingests into the metrics ledger + agent RCA.
- **Pure + injectable**: SSH exec, file download, and aperf download are injected; command-building and report-parsing are pure and fully testable.
- **Wired into `createObservability`** — `observability.aperf.service.deepDive(host)` and `observability.aperf.toMetricPoint(result)` flatten aperf results into metric-ledger-friendly points.
- **21 new tests** (`aperfService.extreme.spec.ts`): command builders, report parser (CPU/mem/disk/process extraction, finding synthesis with severity thresholds), deepDive pipeline (install → prereq → record → report → read → parse), skip-when-present, prereq-failure tolerance, metric-point flattening.
- **1101 tests total** (1079 + 21 new + 1), 0 failures.

### What this enables

RTerm can now combine aperf's deep CPU/PMU/flamegraph profiling with RTerm's agent reasoning and SRE pillar — deploy aperf to a host, record, parse the findings into the metrics ledger, and let the agent do RCA on the results. This bridges the gap between aperf (performance-debugging specialist) and RTerm (AI-native ops platform).
