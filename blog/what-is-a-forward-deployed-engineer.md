# What Is a Forward Deployed Engineer — and Why the Role Needs Its Own Tooling

*The FDE role went mainstream when Sam Altman put it on OpenAI's hiring page.
Here's what FDEs actually do all day, and why generic dev tools keep failing them.*

## The job, minus the mythology

A Forward Deployed Engineer is an engineer who works **inside someone else's
production environment**. Not a lab. Not staging. The customer's messy,
undocumented, half-migrated estate — under a clock, with their VP watching.

Strip away the vendor slides and the job is five moves:

1. **Set the stage** — name the environment, the blast radius, the clock
2. **Gather facts** — pull ground truth from every box, in parallel; never guess
3. **Track the issue** — form a hypothesis and drive it with tools
4. **Resolve under guardrails** — change production *safely*, prove it worked
5. **Lock it in** — automate the recurrence so it never pages anyone again

That fifth move is what separates an FDE from a firefighter.

## Why generic tooling breaks on this job

The default FDE kit — iTerm/SecureCRT, a pile of Ansible repos, a notes app,
screenshots for evidence — fails in predictable ways:

| Failure | Cost |
|---|---|
| N windows for N hosts (Linux SSH + Windows RDP/WinRM + serial + Cisco) | context-switching; missed signals |
| Facts live in tribal memory | every engagement re-discovers the estate |
| Changes applied by hand-rolled scripts | no validation, no rollback, no approval trail |
| Evidence = screenshots | audits become archaeology |
| Fixes are one-offs | the same incident returns next quarter |

## What purpose-built looks like

[RTerm](https://github.com/DrOlu/RTerm) was designed around that five-move loop.
The short version of [the field guide](https://fde.rterm.app/):

- **Reach**: one window into everything — SSH, WinRM, serial console, Cisco
  IOS-XE/XR with proper terminal handling, local shell. PuTTY session import for
  day one of an engagement.
- **Command**: run the same check across the fleet in parallel; inventory hosts
  automatically into structured facts you can act on.
- **Agent**: hand the tedious observe→reason→act loop to an AI agent — bounded
  by a policy engine (allow read/status, deny destructive, escalate prod changes)
  and an optional second "checker" model reviewing every consequential action.
- **Operations**: production changes go through plan → human approval → run →
  validate → automatic rollback. Every action lands in a hash-chained audit
  ledger that can be sealed into independently verifiable evidence bundles.
- **Lock it in**: turn any fix into a playbook, trigger, SLO, or scheduled task —
  the leave-behind becomes part of the customer's operations, not your laptop.

And because the same engine runs headless (`npm i -g rterm-backend`), the whole
workstation can be handed to the customer's team at engagement end — or driven
by CI and other agents over its WebSocket API.

## The market moved

OpenAI, Palantir, Anthropic, and every AI-forward consultancy now hire for this
role explicitly. The tools are catching up slower than the title.
[RTerm](https://github.com/DrOlu/RTerm) is an attempt to close that gap — built
by people who do the job.
