# Changelog

## v2.6.0 (2026-07-22)

### AWS APerf Performance Deep-Dive

- **New: `aperfService`** — deploys the [AWS APerf](https://github.com/aws/aperf) CLI to a host via SSH, records deep system performance metrics (CPU, memory, disk, network, PMU counters, processes, hotspot data), generates the aperf analysis report, and parses the findings into structured results that RTerm ingests into the metrics ledger + agent RCA.
- **Pure + injectable**: SSH exec, file download, and aperf download are injected; command-building and report-parsing are pure and fully testable.
- **Wired into `createObservability`** — `observability.aperf.service.deepDive(host)` and `observability.aperf.toMetricPoint(result)` flatten aperf results into metric-ledger-friendly points.
- **21 new tests** (`aperfService.extreme.spec.ts`): command builders, report parser (CPU/mem/disk/process extraction, finding synthesis with severity thresholds), deepDive pipeline (install → prereq → record → report → read → parse), skip-when-present, prereq-failure tolerance, metric-point flattening.
- **1101 tests total** (1079 + 21 new + 1), 0 failures.

### What this enables

RTerm can now combine aperf's deep CPU/PMU/flamegraph profiling with RTerm's agent reasoning and SRE pillar — deploy aperf to a host, record, parse the findings into the metrics ledger, and let the agent do RCA on the results. This bridges the gap between aperf (performance-debugging specialist) and RTerm (AI-native ops platform).
