# Settings-driven features (v5)

This note records which observability features are **settings-driven** (persisted in
`gyshell-backend-settings.json`, editable in the Settings UI, live-reloaded without a
restart) and which are intentionally **not**, with the reasoning. Schema v5.

## Settings-driven (wired, live-reload)

These blocks are persisted, normalized by `settings/migrations.ts` (each has a
`normalize*Settings` guard), read by `createObservability`, and re-applied on every
settings change via `SettingsService.onDidChange` → `refresh*()`.

| Settings block | Service | Live refresh | Settings UI section |
|---|---|---|---|
| `cost.modelPrices` + `cost.budgets` | `CostBudgetService` | `refreshCost()` | **AI Cost** |
| `alerts.channels` | `AlertService` (live channel array) | `refreshAlertChannels()` | **Alerts** |
| `oncall.pagingChannels` | `EscalationService.setChannels()` | `refreshOncallChannels()` | **On-Call** |
| `cloud.accounts` | `CloudInventory.setAccounts()` | `refreshCloudAccounts()` | **Cloud** |

**Secrets are never stored inline.** Channels/accounts carry a `secretRef` — a key in the
AES-256-GCM secrets vault — resolved only at send/sync time. Webhook URLs for on-call
paging may be inline (`webhookUrl`) or via `secretRef`. Cloud credentials are a vault
`KEY=VAL` env blob (or named profile) injected into the provider CLI call. With no cloud
accounts configured, the ambient provider CLI credentials are used.

## Intentionally NOT a top-level settings block: the review (maker/checker) model

The review model is **agent-profile-bound**, not a global settings block, by design:

- `reviewModelId` and `reviewMode` (`strict` / `advisory` / `auto-approve`) are fields on
  **`ModelProfile`** (`types/index.ts`, duplicated in the preload type). They are already
  editable in the **Settings → Models → Profiles** editor (model picker + mode select,
  with tooltips). That is their single source of truth.
- `ReviewService.runReviewModel` is a **runtime function injection** (a live model
  callable), not a scalar config value — it cannot be expressed in a settings file.
- `reviewerId` is an identity label derived from the chosen review model, not independent
  config.

Adding a parallel top-level `review` settings block would duplicate
`ModelProfile.reviewModelId`/`reviewMode` and create two competing sources of truth for
the same behavior. **Conclusion:** keep it profile-bound; no new settings block.

## Why these five and not more

The remaining `createObservability` deps are **runtime handles, not user config**:
`setMonitorPublisher`, `runAgentForEval`, `onBackgroundDrivers` (timers), and the OTel
exporter are live code/callbacks wired by the runtime. They are correctly injected and
should never be serialized to settings.
