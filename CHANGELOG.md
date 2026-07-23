# Changelog

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
