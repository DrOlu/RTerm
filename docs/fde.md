# RTerm for Forward Deployed Engineers (FDE)

> **RTerm is a full-fledged FDE tool.** Reach into any customer estate, execute across fleets, change production safely, and leave behind automation — from one window, under your control.

This is the field guide for using RTerm as your primary Forward Deployed Engineer workstation. For the full product story, see the [README](../README.md).

---

## Why RTerm for FDE work

An FDE's job: land in someone else's messy estate, get truth fast, change production safely, leave the customer better, and prove it. RTerm is built for exactly that loop.

| FDE job | What "full-fledged" means | RTerm layer |
|---|---|---|
| Get in | Every box from one window: Linux SSH, Windows WinRM/SSH, serial, Cisco, local | **Reach** |
| See truth | Parallel facts, not tribal memory | **Command** |
| Do the work | Observe → reason → act, with you in the loop | **Agent** |
| Change prod | Plan → approve → run → validate → auto-rollback | **MOP change management** |
| Stay up at 2am | Detect, page, remediate, RCA | **SRE observability** |
| Leave a trail | Who did what, on which host, with proof | **Hash-chained audit + session recording** |
| Leave the site better | Playbooks, triggers, SOPs, device memory | **Lock it in** |
| Work from anywhere | Laptop, bastion daemon, phone | **Desktop + neuralOS + mobile-web** |

---

## The FDE operating rhythm

Every scenario follows the same field rhythm — the loop you'll actually run on site:

1. **Set the stage** — environment, blast radius, clock
2. **Gather facts** — never guess (`collect_facts`, fleet commands, metrics)
3. **Track the issue** — hypothesis + tool loop (or let the agent drive under policy)
4. **Resolve under guardrails** — command policy, maker/checker, MOP approval, prove it
5. **Lock it in** — playbook / trigger / SLO / device memory / GitOps / sealed evidence

The fifth step is what separates an FDE from a firefighter: turning a one-off fix into a playbook, a trigger, a dashboard, or a policy so the next incident is faster (or never happens).

---

## Week 0 — land and map the estate

You don't start by fixing. You start by reach + inventory.

- Import jump boxes (SSH, WinRM, serial, Cisco with `algorithmsPreset=cisco`). PuTTY `.reg` import supported.
- Group by site/env: `manage_group` → `prod-core`, `prod-windows`, `lab`
- `collect_facts` + `get_cloud_inventory` — on-prem and AWS/GCP/Azure in one picture
- `manage_device_memory` on day one: role, standing instructions, known landmines

**Give the agent:**

> Inventory every open tab. For each host: hostname, OS, uptime, default route, disk >80%. Write device memory: role + "never bounce BGP without `show ip bgp sum` first."

That's the undocumented estate becoming a CMDB you can act on.

---

## Day-to-day — one window, mixed estate

| Situation | How in RTerm |
|---|---|
| "Is the farm up?" | Fleet command / facts on all open tabs |
| "This build is red" | Agent loop on Local: compile → read error → patch → retest |
| "Windows box is weird" | WinRM persistent runspace + ETW (`manage_etw`) |
| "Router neighbor down" | Cisco tab + Jinja template + `show` validate |
| "Don't lose this session" | `manage_recording` → replay / export `.cast` |
| "Approve from the car" | Mobile-web companion + pending-approval badge |

Human-in-the-loop is native: type in the same tab, reject a command, or force MOP.

---

## Production change — the FDE differentiator

A forward deployed engineer cannot "just SSH and hope." RTerm's change path is:

**template → playbook (validate + rollback) → MOP (plan → you approve → run) → ledger**

1. `manage_template` render with `{{asn}}` / `{{vip}}`
2. Playbook: snapshot → apply → `expect` in `show` / `nginx -t` / `/health`
3. `manage_change plan` — review blast radius
4. **You approve** (the agent must not self-approve)
5. Run. Fail validation → **automatic rollback**, status `rolled_back`
6. Audit ledger is hash-chained; seal a Merkle bundle for the customer's audit team

AGT policy on top: allow read/status; deny format/drop; **escalate** restart/patch on `prod-*`. Optional second model (maker/checker) scores correctness, completeness, safety, compliance, accuracy.

---

## Incidents — detect, act, prove, delete the class

**Morning health pass**

> Build dashboard state. Flag anything degraded or trending to breach in 24h. Deep-dive the worst host.

Dashboard lives at `http://<bastion>:17888/dashboard` — share with the customer, no client install.

**Triage**

- Golden signals, days-to-disk-full forecast
- APerf deep-dive on Linux; ETW traces on Windows (`manage_etw`)
- `web-intel`: search the vendor advisory, watch the CVE page
- `manage_oncall page` via Slack/Teams/Telegram/SMTP (secrets in vault)

Fix under MOP, record the tab (`manage_recording`), write the incident + RCA.

**Lock it in — delete the incident class**

> Disk >85% on db-02 → run `wal-prune` playbook; page me only if still >80%. Cooldown 1h. Add an SLO.

Triggers created in chat fire live — no backend restart needed.

---

## A day in the life

| Time | Move | RTerm |
|---|---|---|
| 09:00 | Health pass | dashboard + capacity forecast |
| 09:20 | Triage under policy | facts; agent lists which steps need approval |
| 09:40 | Guarded fix | MOP + validate + record + evidence |
| 14:00 | Prevention | trigger + SLO + SOP skill + device memory |
| 17:30 | VP update | audit ledger writes the paragraph for you |

---

## The leave-behind: you become the platform

This is how RTerm becomes the engagement operating system, not a laptop trick:

| Leave-behind | Mechanism |
|---|---|
| Repeatable ops | Playbooks, dagu YAML DAGs, cron on `gybackend` |
| Self-heal | Pattern / threshold / webhook / page-watch triggers |
| Customer SOPs | `sop-assistant` + your runbooks as skills |
| Patch Tuesday | `patch-manager`: status → plan → MOP → apply |
| Access review | `iam-connector` across Linux + Windows |
| Request desk | `request-router`: risk class → auto / queue / MOP |
| Desired state | GitOps export + drift check in CI |
| Team access | `rterm-backend` / `neuralos` on the bastion, token + CIDR allow-list |
| Long jobs | AgentSpan/Conductor: resume after laptop sleep/crash |
| Multi-site | NATS mesh so triggers fan out across backends |
| Their agent mesh | `synapse-bridge` discover/dispatch/register |
| Shadow AI on endpoints | `numbat-bridge`: detect → governed RTerm response |
| Secrets / spend | Vault + AI cost budgets (warn / throttle / deny) |

Install on their bastion:

```bash
npm i -g rterm-backend   # or neuralos
gybackend                # ws://0.0.0.0:17888
```

You work in the desktop app against the same engine; CI and other agents call the gateway (`gateway:describe` — the API documents itself).

---

## Honest limits

RTerm is the execution + evidence plane. Pair it, don't fake it:

| Still use | Why |
|---|---|
| Customer ITSM (ServiceNow / Jira / BMC) | Tickets, CAB calendar — RTerm can *do* the change and attach evidence |
| IdP / PAM they already have | RTerm vault is for *agent* secrets, not enterprise IAM |
| CrowdStrike / Defender / SIEM | RTerm is agentless over SSH/WinRM; it does not replace EDR |
| Terraform / Helm at scale | RTerm shines at **day-2** and brownfield; use GitOps for greenfield IaC |
| Their chat | RTerm notifies *out* (Slack/Teams/Telegram); it is not Slack |

---

## Minimum FDE kit to stand up on site

1. Desktop app on your laptop
2. `gybackend` on the customer bastion (own data dir)
3. Connections grouped; Cisco/Windows presets correct
4. Policy: deny destructive; escalate `prod-*`
5. Vault unlocked; alert + on-call channels set
6. Dashboard URL shared with the customer
7. One "health pass" playbook + one "safe change" MOP playbook on day one
8. Device memory on every critical host before you leave

---

## Related docs

- [Backend usage](./gybackend-usage.md) — headless daemon + gateway
- [Mobile-web usage](./mobile-web-usage.md) — approve from your phone
- [AgentSpan integration](./agentspan-integration.md) — durable agents
- [Settings-driven features](./settings-driven-features.md) — alerts, on-call, cost, cloud
