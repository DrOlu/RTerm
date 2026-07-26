# AgentSpan / Conductor integration (agentspan-bridge)

Run **durable, crash-resilient agents** on an [AgentSpan](https://github.com/agentspan-ai/agentspan)
(Netflix Conductor) server from RTerm — the missing piece RTerm doesn't have built in:
**a crashed or restarted agent run resumes from the last completed step**, instead of just
being marked `aborted` in a ledger.

## What AgentSpan adds that RTerm / neuralOS doesn't already have

| Capability | RTerm today | AgentSpan bridge |
|---|---|---|
| Durable agent execution (resume-from-step on crash) | ⚠️ logs runs, marks stale aborted | ✅ Conductor engine resumes |
| Plan-execute determinism (LLM plans once → immutable workflow) | ⚠️ interactive ReAct loop | ✅ compile-once, run deterministically |
| Enterprise event triggers (Kafka / SQS / AMQP / DB) | ⚠️ pattern/threshold/webhook/cron | ✅ Conductor event handlers |
| Visual execution UI (live workflow graph) | ⚠️ dashboards / run-ledger | ✅ AgentSpan server UI |
| Multi-framework + multi-language agents | ❌ RTerm's own TS agent only | ✅ OpenAI/LangChain/ADK/Vercel + Python/C#/Java |

RTerm keeps what it's best at (terminal/SSH/WinRM/fleet, SRE observability, governance/audit,
secrets vault, cost budgets, playbooks). The bridge is **complementary**: AgentSpan = the durable
agent brain, RTerm = the terminal + ops + governance body.

## Architecture — sidecar + plugin bridge

```
RTerm (agentspan-bridge plugin)  ──HTTP──▶  AgentSpan server (Conductor)  :6767
   6 agent tools, 1 trigger, 1 panel              durable workflows + UI
        ▲                                                    │
        └──────── resume-from-step / status / approve ◀──────┘
```

- **Sidecar:** the AgentSpan server runs alongside `rterm-backend` (separate process, no RTerm
  core changes).
- **Bridge:** a pure plugin (`plugins/agentspan-bridge`) — auto-integrated by the existing plugin
  registry. A dependency-free `conductorClient.mjs` talks to the AgentSpan `/api/agent/*` and
  Conductor `/api/workflow/*` REST surfaces.

## Run the sidecar

```bash
# one-time: install the AgentSpan CLI
curl -fsSL https://raw.githubusercontent.com/agentspan-ai/agentspan/main/cli/install.sh | sh
# or: npm install -g @agentspan-ai/agentspan

# start the server (Java required) — UI + API on http://localhost:6767
agentspan server start

# health check
curl http://localhost:6767/actuator/health
```

For a remote server, set `AGENTSPAN_SERVER_URL=https://your-server:6767`.

## Configure RTerm

**Settings → AgentSpan** (or the `agentspan` settings block):

```jsonc
{
  "agentspan": {
    "serverUrl": "http://localhost:6767",      // optional; this is the default
    "authSecretRef": "agentspan-auth",          // optional vault key
    "enabled": true
  }
}
```

`authSecretRef` (only needed when the AgentSpan server has standalone auth on) points at a vault
key holding:

```
AGENTSPAN_AUTH_KEY=your-app-key
AGENTSPAN_AUTH_SECRET=your-app-secret
```

Seed it via the agent's `manage_secret` tool after unlocking the vault
(`RTERM_SECRETS_MASTER_KEY`). Secrets are never stored inline in settings.

## Agent tools (6)

| Tool | What it does |
|---|---|
| `agentspan_health` | server reachable? auth configured? |
| `agentspan_run` | start a durable agent (`agentConfig`) or named Conductor `workflow`; returns the execution id + UI link |
| `agentspan_status` | detailed status (per-task progress, failed tasks, reason) — agent surface first, workflow engine fallback |
| `agentspan_approve` | respond to a paused human-in-the-loop `HUMAN` task and resume |
| `agentspan_list` | list recent executions (Conductor freeText query + size) |
| `agentspan_stop` | terminate a running execution |

Plus a **`agentspan_execution_failed`** trigger (fires on FAILED/TERMINATED/TIMED_OUT → propose a
remediation change) and an **AgentSpan Executions** dashboard panel.

When the server is unreachable, every tool returns a clear
`{error, hint: "Is the AgentSpan server running? …"}` instead of crashing the agent.

## Example

> "Run the `disk-cleanup` workflow as a durable job on AgentSpan and tell me the execution id."

The agent calls `agentspan_run { workflow: "disk-cleanup", input: { host: "web-01" } }`, returns
`workflowId` + a link to the live execution in the AgentSpan UI. If RTerm or the machine restarts,
the run continues; `agentspan_status` reports it resumed from the last step.

## Files

- `plugins/agentspan-bridge/plugin.json` — manifest (6 tools, 1 trigger, 1 panel)
- `plugins/agentspan-bridge/index.mjs` — plugin entry (config, tools, trigger, panel)
- `plugins/agentspan-bridge/conductorClient.mjs` — dependency-free Conductor HTTP client
- `plugins/agentspan-bridge/agentspan-bridge.extreme.spec.ts` — 26 offline tests (mocked fetch)
- Settings: `agentspan` block (schema v5) + **Settings → AgentSpan** UI section
