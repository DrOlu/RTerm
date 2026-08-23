# AI SRE Tools: Where Agents Actually Execute (2026 Landscape)

*"AI SRE" is becoming a product category. Here's an honest map of who does what —
and where the execution gap still is.*

## The category, honestly drawn

"AI SRE" now covers at least four distinct things, often conflated:

1. **AI-assisted observability** — anomaly detection, alert correlation,
   noise reduction (classic AIOps: Datadog Watchdog, Dynatrace Davis, BigPanda)
2. **AI incident copilots** — summarize the incident, draft the timeline,
   suggest queries (Rootly AI, FireHydrant, Resolve.ai)
3. **RCA engines** — topology-aware probable-cause analysis
4. **Agents that execute remediation** — actually *do* the fix on infrastructure

Categories 1–3 are maturing fast. Category 4 is where most tools stop at
"we triggered your webhook." The hard problem isn't deciding what to do — it's
doing it safely on real, heterogeneous infrastructure and proving what happened.

## The execution gap, concretely

Ask any vendor in 1–3 what happens after the alert fires:

> "We call your runbook automation."

Ask what happens if the runbook doesn't cover this failure mode:

> "…your engineer investigates."

That handoff — from correlated alert to someone SSHing into a box at 2am with
production access and no guardrails — is the unsolved part of the AI SRE story.
It's also exactly the part [RTerm](https://github.com/DrOlu/RTerm) automates.

## How RTerm fits the landscape

RTerm is not another dashboard. It's the **agent-with-hands** layer:

| Layer | Typical tool | RTerm's answer |
|---|---|---|
| Detect | your AIOps platform | consumes its webhooks; lightweight built-in metrics/anomaly/forecasting |
| Decide | correlation engine | AI agent reasoning over live host state, under allow/deny/escalate policy |
| **Act** | webhook → your scripts | **native agent-driven execution over SSH/WinRM/serial — with MOP approval gates and automatic rollback** |
| Prove | alert log | hash-chained audit ledger, Merkle-sealed evidence, recorded sessions |

The distinctive bits for SRE teams evaluating AI agents:

- **Agentless reach**: talks to hosts over the protocols they already speak —
  critical for brownfield and customer estates where you can't install agents.
- **Guardrails as a first-class feature**: policy engine + maker/checker review
  model evaluate every consequential action before it runs. Prod changes require
  human approval through built-in change management.
- **Evidence by default**: every action lands in a tamper-evident ledger —
  the postmortem writes itself, and compliance gets verifiable proof.
- **Runs anywhere**: desktop app for interactive work, headless daemon
  (`npm i -g rterm-backend`) for bastion/CI, WebSocket API for other agents.

## Practical pairings

- **Datadog/PagerDuty + RTerm**: platform detects and pages → trigger fires an
  RTerm playbook → agent diagnoses on-host under policy → fix applied via
  approved change or held for human approval → evidence sealed.
- **Grafana + RTerm**: alerts route to RTerm triggers; remediation and
  investigation happen where the infrastructure is.
- **Standalone RTerm**: small teams run its built-in golden signals, SLOs,
  incident ledger, and on-call paging as the entire stack.

## Bottom line

The AI SRE category is real, but most of it stops one step short of production.
When comparing tools, ask exactly one question: *"Show me the agent changing
something on a real host — and then show me who approved it and how you'd prove
it afterward."* [RTerm](https://github.com/DrOlu/RTerm) was built to be the tool
that survives that question.
