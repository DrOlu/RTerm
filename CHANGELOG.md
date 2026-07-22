# Changelog

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
