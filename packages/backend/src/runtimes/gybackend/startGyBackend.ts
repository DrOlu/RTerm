import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { TerminalService } from "../../services/TerminalService";
import { FileSystemService } from "../../services/FileSystemService";
import { FileTransferService } from "../../services/FileTransferService";
import { AgentService_v2 } from "../../services/AgentService_v2";
import { UIHistoryService } from "../../services/UIHistoryService";
import { ChatHistoryService } from "../../services/ChatHistoryService";
import { GatewayService } from "../../services/Gateway/GatewayService";
import { WebSocketGatewayAdapter } from "../../services/Gateway/WebSocketGatewayAdapter";
import {
  WebSocketGatewayControlService,
  resolveWsGatewayAccessFromHost,
  resolveWsGatewayPolicyFromEnv,
} from "../../services/Gateway/WebSocketGatewayControlService";
import { NodeSettingsService } from "../../adapters/node/NodeSettingsService";
import { NodeCommandPolicyService } from "../../adapters/node/NodeCommandPolicyService";
import { NodeMcpToolService } from "../../adapters/node/NodeMcpToolService";
import { NodeSkillService } from "../../adapters/node/NodeSkillService";
import { NodeMemoryService } from "../../adapters/node/NodeMemoryService";
import { NodeAccessTokenService } from "../../adapters/node/NodeAccessTokenService";
import { ModelCapabilityService } from "../../services/ModelCapabilityService";
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary,
} from "../../services/Gateway/toolingSummary";
import { ImageAttachmentService } from "../../services/ImageAttachmentService";
import { TerminalStateStore } from "../../services/terminal/TerminalStateStore";
import { createAutoTerminalConfig } from "../../services/terminal/terminalConnectionSupport";
import { TerminalCommandDraftService } from "../../services/TerminalCommandDraftService";
import { ConnectionManager } from "../../services/ConnectionManager";
import { AutomationManager } from "../../services/automation/AutomationManager";
import { AgentRunLedger } from "../../services/agentRunLedger";
import { ChangeLedger } from "../../services/changeLedger";
import { SessionLogService } from "../../services/automation/sessionLogService";
import { SchedulerService } from "../../services/automation/schedulerService";
import { SettingsBackupService } from "../../services/settings/settingsBackup";
import { IdleTimeoutService } from "../../services/terminal/idleTimeout";
import { defaultRestRoutes, handleRestRequest } from "../../services/Gateway/restApi";
import { GatewayRateLimiter } from "../../services/Gateway/gatewayRateLimit";
import { executeScheduledTask } from "../../services/automation/scheduledTaskRunner";
import { HistoryStorageMigration } from "../../services/history/HistoryStorageMigration";
import { HistorySqliteStore } from "../../services/history/HistorySqliteStore";
import { AgentSettingProfileService } from "../../services/AgentSettingProfileService";
import { createTriggerRuntime } from "../../services/automation/triggerRuntime";
import { createObservability } from "../../services/observability";
import { createObservabilityBridge } from "../../services/Gateway/observabilityBridge";
import { renderLiveDashboardHtml } from "../../services/dashboard/renderDashboardHtml";
import { dashboardHttpAuthorized } from "../../services/dashboard/dashboardHttpAuth";
import { searchMemory, appendMemoryNote } from "../../memory/memoryManager";
import { ResourceMonitorService } from "../../services/ResourceMonitorService";

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || "");
  if (!Number.isInteger(raw) || raw <= 0 || raw >= 65536) {
    return fallback;
  }
  return raw;
}

function resolveDataDir(): string {
  const custom = (process.env.GYBACKEND_DATA_DIR || "").trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(process.cwd(), ".gybackend-data");
}

export async function startGyBackend(): Promise<void> {
  const dataDir = resolveDataDir();
  process.env.GYSHELL_STORE_DIR = dataDir;
  const historyMigration = new HistoryStorageMigration({ baseDir: dataDir });
  await historyMigration.run();
  const defaultHost =
    (process.env.GYBACKEND_WS_HOST || "0.0.0.0").trim() || "0.0.0.0";
  const defaultPort = numberFromEnv("GYBACKEND_WS_PORT", 17888);
  const startupPolicy = resolveWsGatewayPolicyFromEnv({
    env: process.env,
    defaultPolicy: {
      access: resolveWsGatewayAccessFromHost(defaultHost),
      port: defaultPort,
      hostOverride: defaultHost,
    },
    enableVarName: "GYBACKEND_WS_ENABLE",
    hostVarName: "GYBACKEND_WS_HOST",
    portVarName: "GYBACKEND_WS_PORT",
  });
  const bootstrapLocalTerminal = boolFromEnv(
    "GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL",
    true,
  );

  const settingsService = new NodeSettingsService(dataDir);
  const commandPolicyService = new NodeCommandPolicyService(dataDir);
  const mcpToolService = new NodeMcpToolService(dataDir);
  const skillService = new NodeSkillService(dataDir, settingsService);
  const memoryService = new NodeMemoryService(dataDir);
  const accessTokenService = new NodeAccessTokenService(dataDir);
  const modelCapabilityService = new ModelCapabilityService();
  const imageAttachmentService = new ImageAttachmentService(dataDir);

  const terminalStateStore = new TerminalStateStore(
    path.join(dataDir, "terminal-tabs-state.json"),
  );
  const terminalService = new TerminalService({
    terminalStateStore,
  });
  const fileSystemService = new FileSystemService(terminalService);
  const fileTransferService = new FileTransferService(
    fileSystemService,
    terminalService,
  );
  const historyStore = new HistorySqliteStore();
  process.once("exit", () => {
    terminalService.flushPersistedState();
    historyStore.close();
  });
  const uiHistoryService = new UIHistoryService({ store: historyStore });
  const chatHistoryService = new ChatHistoryService({ store: historyStore });
  const agentService = new AgentService_v2(
    terminalService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    uiHistoryService,
    chatHistoryService,
    imageAttachmentService,
    fileTransferService,
  );
  const agentSettingProfileService = new AgentSettingProfileService({
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    onSettingsChanged: (settings) => agentService.updateSettings(settings),
  })
  // Agent Setting auto-save (v3.2.9): while a profile is active, any settings
  // change is written back into that profile automatically (no manual overwrite).
  // The service guards against re-entrancy (the write-back itself changes settings).
  settingsService.onDidChange?.(() => {
    void agentSettingProfileService.autoSaveActiveProfile()
  });

  const gatewayService = new GatewayService(
    terminalService,
    agentService,
    uiHistoryService,
    commandPolicyService,
    settingsService,
    mcpToolService,
  );
  fileTransferService.setRawEventPublisher((channel, data) =>
    gatewayService.broadcastRaw(channel, data),
  );
  const terminalCommandDraftService = new TerminalCommandDraftService(
    terminalService,
    settingsService,
  );

  const terminalRestoreResult =
    await terminalService.restorePersistedTerminals();
  if (
    terminalRestoreResult.restored.length > 0 ||
    terminalRestoreResult.failed.length > 0
  ) {
    console.log(
      `[gybackend] Terminal restore completed. restored=${terminalRestoreResult.restored.length} failed=${terminalRestoreResult.failed.length}`,
    );
    if (terminalRestoreResult.failed.length > 0) {
      terminalRestoreResult.failed.forEach((item) => {
        console.warn(
          `[gybackend] Terminal restore failed for ${item.id}: ${item.reason}`,
        );
      });
    }
  }

  agentService.updateSettings(settingsService.getSettings());
  await skillService.reload();
  await mcpToolService.reloadAll();

  // Wire the connection manager so the `manage_ssh_connection` agent tool can
  // create/update/delete saved SSH connections. Mutations persist via the
  // settings service, refresh the agent runtime, and broadcast `settings:updated`
  // so the UI's Connections panel refreshes live.
  agentService.setConnectionManager(
    new ConnectionManager({
      getSettings: () => settingsService.getSettings(),
      setSettings: (patch) => settingsService.setSettings(patch),
      onSettingsChanged: (next) => agentService.updateSettings(next),
      broadcastSettings: (next) =>
        gatewayService.broadcastRaw("settings:updated", next),
    }),
  );

  // Automation subsystems (local-only Netcatty/NetStacks parity): connection
  // groups, per-device memory, saved scripts, scheduled tasks, config
  // templates. Mutations persist to settings.automation + broadcast so the UI
  // refreshes. (The agent tools read this via ToolExecutionContext.automationManager.)
  const automationManager = new AutomationManager({
    getSettings: () => settingsService.getSettings(),
    setSettings: (patch) => settingsService.setSettings(patch),
    onSettingsChanged: (next) => agentService.updateSettings(next),
    broadcastSettings: (next) =>
      gatewayService.broadcastRaw("settings:updated", next),
  });
  agentService.setAutomationManager(automationManager);

  // Agent run ledger: persisted audit + token-cost record of every agent run
  // (SQLite, survives restarts). On boot, close out runs orphaned by a crash.
  const agentRunLedger = new AgentRunLedger();
  agentRunLedger.markStaleRunsAborted(Date.now());
  agentService.setAgentRunLedger(agentRunLedger);
  const changeLedger = new ChangeLedger();
  changeLedger.markStaleChangesAborted(Date.now());
  agentService.setChangeLedger(changeLedger);

  // Advanced Automation: event-driven trigger engine. Loads persisted triggers,
  // feeds terminal output (pattern) + monitor snapshots (threshold), and fires
  // playbooks (or proposes MOP changes) on match.
  const resourceMonitorService = new ResourceMonitorService(terminalService);

  // NATS event mesh (optional): when settings.nats is enabled, local terminal/
  // monitor events publish onto the bus and remote bus events feed the engine,
  // so triggers fire fleet-wide. Best-effort — a NATS outage never blocks ops.
  let natsBus: import("../../services/automation/natsEventBus").NatsEventBus | null = null;
  try {
    const { NatsEventBus, resolveNatsOptions } = await import("../../services/automation/natsEventBus");
    const natsOpts = resolveNatsOptions(settingsService.getSettings());
    if (natsOpts) {
      natsBus = new NatsEventBus(natsOpts);
      await natsBus.connect();
    }
  } catch (e) {
    console.warn(`[gybackend] NATS mesh unavailable: ${e instanceof Error ? e.message : String(e)}`);
    natsBus = null;
  }

  const triggerEngine = createTriggerRuntime({
    automationManager,
    terminalService,
    monitorService: resourceMonitorService,
    natsBus,
    runPlaybook: async (playbookId, _reason) => {
      const playbook = automationManager.getPlaybook(playbookId);
      if (!playbook) return `playbook "${playbookId}" not found`;
      try {
        const { executeOrchestratedPlaybook } = await import("../../services/automation/orchestratedPlaybookRunner");
        const rec = await executeOrchestratedPlaybook(
          { terminalService, automationManager, getSettings: () => settingsService.getSettings(), onLog: () => {} },
          playbook,
        );
        return rec.ok ? `ok (runId=${rec.runId})` : `failed (runId=${rec.runId})`;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    proposeChange: async (playbookId, reason) => {
      const playbook = automationManager.getPlaybook(playbookId);
      if (!playbook) return `playbook "${playbookId}" not found`;
      const changeId = `chg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        changeLedger.createChange({ changeId, playbookId: playbook.id, playbookName: playbook.name, targetsSnapshot: JSON.stringify([`trigger:${reason.slice(0, 80)}`]) });
        return `proposed change ${changeId} (${reason.slice(0, 60)})`;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    onLog: () => {},
  });
  agentService.setTriggerEngine(triggerEngine);

  // Observability (v2.0.0–v2.3.0): SRE metrics/watchdog/SLO/alerts/incidents,
  // APM spans, DEM RUM, k8s/cloud infra, ETW diagnostics, unified dashboard,
  // predictive anomaly/early-warning, behavioral analytics, embedded evals.
  // Feeds live monitor snapshots into the metrics ledger and wires watchdog →
  // alert (notify channels) → incident. Exposes the unified dashboard state.
  const observability = createObservability({
    terminalService,
    agentService,
    automationManager,
    agentRunLedger,
    gatewayService,
    resourceMonitorService,
    settingsService,
    setMonitorPublisher: (pub) => resourceMonitorService.setPublisher((channel: string, data: unknown) => {
      pub(channel, data);
    }),
    onLog: () => {},
  });
  console.log(`[gybackend] Observability wired: dashboard state available (hosts=${observability.metricsLedger.hosts().length})`);
  // Live-reload AI cost prices + budgets, alert channels, AND on-call paging
  // channels whenever settings change (no restart).
  const refreshObservabilityFromSettings = (): void => {
    try {
      observability.refreshCost?.();
    } catch {
      /* best-effort */
    }
    try {
      observability.refreshAlertChannels?.();
    } catch {
      /* best-effort */
    }
    try {
      observability.refreshOncallChannels?.();
    } catch {
      /* best-effort */
    }
    try {
      observability.refreshCloudAccounts?.();
    } catch {
      /* best-effort */
    }
  };
  settingsService.onDidChange?.(refreshObservabilityFromSettings);
  // Wire the observability handle into the agent so the observability_* tools
  // (metrics, secrets, on-call, cost, recording, gitops, playbooks, cloud, live
  // dashboard) work in chat.
  agentService.setObservability(observability);
  // Wire the session recorder so terminal output feeds live recordings (asciinema).
  terminalService.setSessionRecorder(observability.recording);

  // Wire plugin tools into the agent so the model can call them in chat.
  // The PluginRegistry (inside observability) discovers + loads + registers all
  // plugins from the plugins/ dir. We collect their tools and inject them into
  // the agent's tool executor + tool schema list.
  // Non-blocking: a 10s timeout prevents a hanging plugin's register() (e.g. a
  // NATS connect that never resolves) from blocking the boot. Tools are wired
  // whenever the reload completes (or skipped on timeout, with a warning).
  Promise.race([
    observability.pluginRegistry.reload(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('plugin reload timeout (10s)')), 10000)),
  ]).then((pluginRecords) => {
    const pluginTools: Array<{ name: string; description: string; params: any; handler: (params: any) => Promise<any> }> = [];
    for (const record of pluginRecords) {
      if (record.error || !record.enabled) continue;
      for (const tool of record.tools) {
        pluginTools.push({
          name: tool.name,
          description: tool.description ?? '',
          params: tool.params ?? {},
          handler: tool.handler as (params: any) => Promise<any>,
        });
      }
    }
    if (pluginTools.length > 0) {
      agentService.setPluginTools(pluginTools);
      console.log(`[gybackend] Wired ${pluginTools.length} plugin tools from ${pluginRecords.filter((r: any) => !r.error && r.enabled).length} plugins into the agent.`);
    } else {
      console.log('[gybackend] No plugin tools found to wire.');
    }
  }).catch((e) => {
    console.warn('[gybackend] Plugin tool wiring skipped:', e instanceof Error ? e.message : String(e));
  });

  // Session logging: record terminal output per session to disk when enabled.
  if (settingsService.getSettings().sessionLogging?.enabled) {
    const logDir = path.join(
      (process.env.GYSHELL_STORE_DIR || ""),
      "session-logs",
    );
    const sessionLogger = new SessionLogService({ logDir });
    terminalService.setSessionLogger(sessionLogger);
    agentService.setSessionLogger(sessionLogger);
  }

  // Scheduled-task scheduler: evaluate due tasks on a per-minute tick and
  // actually execute them — resolve the command (inline or saved script),
  // open a short-lived headless session per target (SSH/WinRM/serial, or the
  // local shell when no scope is set), run to completion, tear down. Session
  // output is captured by the regular session-logging wiring when enabled.
  //
  // v3.2.16: timezone-aware evaluation, overlap guard (skip while running),
  // pause windows, catch-up opt-in, run history, failure streaks → alerts,
  // task→playbook binding, and onSuccess/onFailure chaining.
  const scheduler = new SchedulerService({
    getTasks: () => automationManager.listScheduledTasks(),
    onSkip: (task, reason) => {
      if (reason === "overlap-skip") {
        console.warn(
          `[scheduler] task "${task.name}" still running — skipping this firing (overlap guard)`,
        );
      } else if (reason === "paused") {
        console.log(`[scheduler] task "${task.name}" paused until ${task.pausedUntil}`);
      }
    },
    run: async (task) => {
      console.log(`[scheduler] due task: ${task.name} (${task.cron}${task.timezone ? ` @ ${task.timezone}` : ""})`);
      let allOk = true;
      try {
        const outcomes = await executeScheduledTask(
          {
            terminalService,
            automationManager,
            getSettings: () => settingsService.getSettings(),
            onLog: (line) => console.log(line),
          },
          task,
        );
        const failed = outcomes.filter((o) => !o.ok);
        allOk = failed.length === 0;
        for (const f of failed) {
          console.warn(
            `[scheduler] task "${task.name}" target ${f.target} failed: ${f.error ?? "unknown"}`,
          );
        }
        console.log(
          `[scheduler] task "${task.name}" finished: ${outcomes.length - failed.length}/${outcomes.length} target(s) ok`,
        );
      } catch (error) {
        allOk = false;
        console.warn(
          `[scheduler] task "${task.name}" could not run:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        automationManager.markScheduledTaskRun(task.id);
      }

      // v3.2.16: failure-streak alerting.
      const streak = scheduler.history.consecutiveFailures(task.id);
      const threshold = task.alertAfterFailures ?? 0;
      if (!allOk && threshold > 0 && streak >= threshold) {
        console.warn(
          `[scheduler] task "${task.name}" has failed ${streak} consecutive run(s) — alert threshold ${threshold} reached`,
        );
      }

      // v3.2.16: onSuccess / onFailure chaining.
      const next = allOk ? task.onSuccess : task.onFailure;
      if (next) {
        const nextTask = automationManager.listScheduledTasks().find((t) => t.id === next);
        if (nextTask) {
          console.log(`[scheduler] chaining "${task.name}" → "${nextTask.name}" (${allOk ? "onSuccess" : "onFailure"})`);
          try {
            await scheduler.runNow(nextTask);
          } catch (e) {
            console.warn(`[scheduler] chained task "${nextTask.name}" failed:`, e);
          }
        } else {
          console.warn(`[scheduler] chain target "${next}" not found`);
        }
      }
    },
  });
  scheduler.start();

  if (
    bootstrapLocalTerminal &&
    terminalService.getDisplayTerminals().length === 0
  ) {
    const terminalId = process.env.GYBACKEND_TERMINAL_ID || "local-main";
    const terminalTitle = process.env.GYBACKEND_TERMINAL_TITLE || "Local";
    const terminalCwd = process.env.GYBACKEND_TERMINAL_CWD;
    const terminalShell = process.env.GYBACKEND_TERMINAL_SHELL;

    try {
      await terminalService.createTerminal({
        type: "local",
        id: terminalId,
        title: terminalTitle,
        cols: 120,
        rows: 32,
        cwd: terminalCwd,
        shell: terminalShell,
      });
      console.log(`[gybackend] Bootstrapped terminal: ${terminalId}`);
    } catch (error) {
      console.warn("[gybackend] Failed to bootstrap default terminal:", error);
    }
  }

  const broadcastAgentSettingResult = (result: {
    settings: unknown;
    commandPolicyLists: unknown;
    mcpTools: unknown;
    builtInTools: unknown;
    skills: unknown;
    memory: unknown;
  }) => {
    gatewayService.broadcastRaw("settings:updated", result.settings);
    gatewayService.broadcastRaw(
      "settings:commandPolicyListsUpdated",
      result.commandPolicyLists,
    );
    gatewayService.broadcastRaw("tools:mcpUpdated", result.mcpTools);
    gatewayService.broadcastRaw("tools:builtInUpdated", result.builtInTools);
    gatewayService.broadcastRaw("skills:updated", result.skills);
    gatewayService.broadcastRaw("memory:updated", result.memory);
  };

  // ── v3.2.18 wiring: settings backup, idle timeout, rate limiting, REST routes ──

// Gateway rate limiter: per-client token bucket + auth-failure lockout.
const gatewayRateLimiter = new GatewayRateLimiter({
  capacity: Number(process.env.RTERM_RATE_LIMIT_BURST ?? 60) || 60,
  refillPerSecond: Number(process.env.RTERM_RATE_LIMIT_REFILL ?? 1) || 1,
  authFailureLimit: 5,
  authLockoutMs: 60_000,
});

  // Settings backup: timestamped backups on every save, rotation, restore.
  const settingsDir = path.dirname(settingsService.getSettingsPath?.() ?? "");
  const backupsDir = settingsDir ? path.join(settingsDir, "backups") : "";
  const settingsBackupService = new SettingsBackupService(
    backupsDir
      ? {
          read: () => fs.readFileSync(settingsService.getSettingsPath!(), "utf8"),
          write: (c) => fs.writeFileSync(settingsService.getSettingsPath!(), c),
          listBackups: () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []),
          readBackup: (n) => fs.readFileSync(path.join(backupsDir, n), "utf8"),
          writeBackup: (n, c) => {
            fs.mkdirSync(backupsDir, { recursive: true });
            fs.writeFileSync(path.join(backupsDir, n), c);
          },
          deleteBackup: (n) => {
            const p = path.join(backupsDir, n);
            if (fs.existsSync(p)) fs.unlinkSync(p);
          },
        }
      : { read: () => "", write: () => {}, listBackups: () => [], readBackup: () => "", writeBackup: () => {}, deleteBackup: () => {} },
    { keep: 20 },
  );
  // Take a backup on every settings save (best-effort — never blocks a save).
  const originalSetSettings = settingsService.setSettings.bind(settingsService);
  settingsService.setSettings = ((next: unknown) => {
    try { settingsBackupService.backup() } catch { /* best-effort */ }
    return originalSetSettings(next as never);
  }) as typeof settingsService.setSettings;

// Idle terminal timeout: close terminals idle past the threshold.
const idleTimeoutService = new IdleTimeoutService({
  idleMinutes: Number(process.env.RTERM_IDLE_TIMEOUT_MINUTES ?? 30) || 30,
  protectedIds: [process.env.GYBACKEND_TERMINAL_ID || "local-main"],
});
  for (const t of terminalService.getAllTerminals()) idleTimeoutService.register(t.id);
  terminalService.onTerminalCreated?.((id: string) => idleTimeoutService.register(id));
  terminalService.onTerminalData?.((id: string) => idleTimeoutService.touch(id));
  terminalService.onTerminalClosed?.((id: string) => idleTimeoutService.forget(id));
  const idleSweeper = setInterval(() => {
    try {
      const idle = idleTimeoutService.idleTerminals(terminalService.getAllTerminals().map((t) => t.id));
      for (const { terminalId, idleMinutes } of idle) {
        console.log(`[gybackend] closing idle terminal ${terminalId} (${idleMinutes}min idle)`);
        try { terminalService.kill(terminalId) } catch { /* already gone */ }
        idleTimeoutService.forget(terminalId);
      }
    } catch { /* best-effort */ }
  }, 60_000);
  if (typeof idleSweeper.unref === "function") idleSweeper.unref();

// REST dispatch: route REST calls through the WS adapter's method dispatch.
// Declared as a mutable binding — the adapter is created below, and REST
// routes only dispatch when a request arrives (by then it exists).
type RestDispatchTarget = { handleRequest?: (m: string, p: Record<string, unknown>) => Promise<unknown> } | null;
let restDispatchTarget: RestDispatchTarget = null;
const restDispatch = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
  const target: RestDispatchTarget = restDispatchTarget;
  if (!target?.handleRequest) {
    throw new Error("REST API is not ready yet (gateway still starting)");
  }
  return await target.handleRequest(method, params);
};

  /**
   * Build the /api/v1/* HTTP routes from the REST route table (sync — the
   * route table is static). Each route authorizes via the same token check as
   * the dashboard, parses the JSON body for POSTs, and dispatches through the
   * gateway.
   */
  const buildRestHttpRoutesSync = (opts: {
    isAuthorized: (req: unknown) => Promise<boolean>;
    dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }): Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> }> => {
    const routes = defaultRestRoutes();
    // The HTTP route table matches paths EXACTLY, so register each concrete
    // REST path. Parameterized paths (:id) register per-segment wildcards via
    // a single /api/v1 catch-all is NOT possible — instead we register the
    // static paths exactly and one dynamic handler per parameterized prefix.
    const staticRoutes = routes
      .filter((r) => !r.path.includes(":"))
      .map((route) => ({
        path: route.path,
        handler: makeRestHandler(routes, opts),
      }));
    // Parameterized paths: the adapter matches exactly, so we cannot register
    // /api/v1/terminals/:id/write directly. Instead expose them through the
    // /api/v1/rpc escape hatch (POST {method:"terminal:write", params:{...}}),
    // which covers every gateway method including these.
    return staticRoutes;
  };

const makeRestHandler = (
  routes: ReturnType<typeof defaultRestRoutes>,
  opts: { isAuthorized: (req: unknown) => Promise<boolean>; dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown> },
) => {
    return async (req: unknown, res: unknown): Promise<void> => {
      const r = req as { method?: string; url?: string };
      const s = res as { writeHead?: (n: number, h: Record<string, string>) => void; end?: (b: string) => void };
      try {
        if (!(await opts.isAuthorized(r))) {
          s.writeHead?.(401, { "content-type": "application/json" });
          s.end?.(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const url = new URL(r.url ?? "/", "http://localhost");
        const body = r.method === "POST" ? await readJsonBody(r as never) : Object.fromEntries(url.searchParams.entries());
        const result = await handleRestRequest(routes, opts.dispatch, {
          method: r.method ?? "GET",
          path: url.pathname,
          body,
        });
        s.writeHead?.(result.status, { "content-type": "application/json" });
        s.end?.(JSON.stringify(result.body));
      } catch (e) {
        s.writeHead?.(500, { "content-type": "application/json" });
        s.end?.(JSON.stringify({ error: "internal", message: e instanceof Error ? e.message : String(e) }));
      }
    };
  };

  const readJsonBody = (req: { on?: (e: string, cb: (d?: Buffer) => void) => void }): Promise<unknown> =>
    new Promise((resolve) => {
      let data = "";
      req.on?.("data", (d) => { data += String(d ?? "") });
      req.on?.("end", () => {
        try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
      });
    });

  const wsGatewayControlService = new WebSocketGatewayControlService({
    createAdapter: (host, port, ipFilter) => {
      const adapter = new WebSocketGatewayAdapter(gatewayService, {
        host,
        port,
        accessTokenAuth: {
          verifyToken: (token: string) => accessTokenService.verifyToken(token),
          allowLocalhostWithoutToken: true,
        },
        // v3.2.18: per-client rate limiting (token bucket + auth lockout).
        rateLimiter: gatewayRateLimiter,
        ipFilter,
        // Browser dashboard on the SAME port as the WS gateway: /dashboard serves
        // a live page (WS push via observability:liveDashboardSubscribe, with a
        // /dashboard/json polling fallback). Auth mirrors the WS gateway —
        // loopback open, remote needs a valid access token.
        // v3.2.18: REST API routes (/api/v1/*) are prepended so curl/CI can
        // drive the gateway without a WS client.
        httpRoutes: [
          ...buildRestHttpRoutesSync({
            isAuthorized: (req) => dashboardHttpAuthorized(req as never, (t) => accessTokenService.verifyToken(t)),
            dispatch: restDispatch,
          }),
          {
            path: "/dashboard",
            handler: async (req, res) => {
              if (!(await dashboardHttpAuthorized(req, (t) => accessTokenService.verifyToken(t)))) {
                res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
                res.end("missing/invalid access token");
                return;
              }
              const state = await observability.dashboard.state();
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              res.end(
                renderLiveDashboardHtml(state, {
                  title: "RTerm · Unified Dashboard",
                  dataUrl: "/dashboard/json",
                }),
              );
            },
          },
          {
            path: "/dashboard/json",
            handler: async (req, res) => {
              if (!(await dashboardHttpAuthorized(req, (t) => accessTokenService.verifyToken(t)))) {
                res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
                res.end("missing/invalid access token");
                return;
              }
              const state = await observability.dashboard.state();
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(state));
            },
          },
        ],
        terminalBridge: {
          listTerminals: () =>
            terminalService.getDisplayTerminals().map((terminal) => ({
              id: terminal.id,
              title: terminal.title,
              type: terminal.type,
              cols: terminal.cols,
              rows: terminal.rows,
              runtimeState: terminal.runtimeState,
              lastExitCode: terminal.lastExitCode,
              monitorIdentity:
                terminalService.getMonitorIdentity(terminal.id) ?? undefined,
            })),
          createTab: async (config) => {
            const snapshot = terminalService.getDisplayTerminals();
            const normalized = createAutoTerminalConfig(snapshot, config);
            const tab = await terminalService.createTerminal(normalized as any);
            return { id: tab.id };
          },
          write: async (terminalId, data) => {
            terminalService.write(terminalId, data);
          },
          writePaths: async (terminalId, paths) => {
            terminalService.writePaths(terminalId, paths);
          },
          resize: async (terminalId, cols, rows) => {
            terminalService.resize(terminalId, cols, rows);
          },
          kill: async (terminalId) => {
            if (terminalService.getDisplayTerminals().length <= 1) {
              throw new Error("Cannot close the last terminal tab.");
            }
            terminalService.kill(terminalId);
          },
          reconnect: async (terminalId) => {
            const tab = await terminalService.reconnectTerminal(terminalId);
            return { id: tab.id };
          },
          setTitle: async (terminalId, title) => {
            terminalService.setTitle(terminalId, title);
          },
          setSelection: async (terminalId, selectionText) => {
            terminalService.setSelection(terminalId, selectionText);
          },
          getBufferDelta: async (terminalId, fromOffset) => {
            const data = terminalService.getBufferDelta(terminalId, fromOffset);
            const offset = terminalService.getCurrentOffset(terminalId);
            return { data, offset };
          },
          generateCommandDraft: async (terminalId, prompt, profileId) => {
            return await terminalCommandDraftService.generateCommandDraft({
              terminalId,
              prompt,
              profileId,
            });
          },
        },
        filesystemBridge: {
          listDirectory: async (terminalId, dirPath) => {
            return await fileSystemService.listDirectory(terminalId, dirPath);
          },
          readTextFile: async (terminalId, filePath, options) => {
            return await fileSystemService.readTextFile(
              terminalId,
              filePath,
              options,
            );
          },
          readFileBase64: async (terminalId, filePath, options) => {
            return await fileSystemService.readFileBase64(
              terminalId,
              filePath,
              options,
            );
          },
          writeTextFile: async (terminalId, filePath, content) => {
            await fileSystemService.writeTextFile(
              terminalId,
              filePath,
              content,
            );
          },
          writeFileBase64: async (
            terminalId,
            filePath,
            contentBase64,
            options,
          ) => {
            await fileSystemService.writeFileBase64(
              terminalId,
              filePath,
              contentBase64,
              options,
            );
          },
          transferEntries: async (
            sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath,
            options,
          ) => {
            return await fileSystemService.transferEntries(
              sourceTerminalId,
              sourcePaths,
              targetTerminalId,
              targetDirPath,
              options,
            );
          },
          startTransfer: async (input) => {
            return fileTransferService.startTransfer(input);
          },
          getTransfer: async (transferId) => {
            return fileTransferService.getTransfer(transferId);
          },
          listTransfers: async (options) => {
            return fileTransferService.listTransfers(options);
          },
          cancelTransfer: async (transferId) => {
            return fileTransferService.cancelTransfer(transferId);
          },
          cancelTransferTask: async (transferId) => {
            return fileTransferService.cancelTransfer(transferId);
          },
          createDirectory: async (terminalId, dirPath) => {
            await fileSystemService.createDirectory(terminalId, dirPath);
          },
          createFile: async (terminalId, filePath) => {
            await fileSystemService.createFile(terminalId, filePath);
          },
          deletePath: async (terminalId, targetPath, options) => {
            await fileSystemService.deletePath(terminalId, targetPath, options);
          },
          renamePath: async (terminalId, sourcePath, targetPath) => {
            await fileSystemService.renamePath(
              terminalId,
              sourcePath,
              targetPath,
            );
          },
        },
        profileBridge: {
          getProfiles: () => {
            const snapshot = settingsService.getSettings();
            const modelNameById = new Map(
              snapshot.models.items.map((item) => [item.id, item.model]),
            );
            return {
              activeProfileId: snapshot.models.activeProfileId,
              profiles: snapshot.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId),
              })),
            };
          },
          setActiveProfile: (profileId: string) => {
            const snapshot = settingsService.getSettings();
            const exists = snapshot.models.profiles.some(
              (profile) => profile.id === profileId,
            );
            if (!exists) {
              throw new Error(`Profile not found: ${profileId}`);
            }

            settingsService.setSettings({
              models: {
                items: snapshot.models.items,
                profiles: snapshot.models.profiles,
                activeProfileId: profileId,
              },
            });

            const next = settingsService.getSettings();
            agentService.updateSettings(next);

            const modelNameById = new Map(
              next.models.items.map((item) => [item.id, item.model]),
            );
            return {
              activeProfileId: next.models.activeProfileId,
              profiles: next.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId),
              })),
            };
          },
          probeModel: async (model: any) => {
            return await modelCapabilityService.probe(model);
          },
        },
        agentBridge: {
          exportHistory: async (sessionId, mode) => {
            await gatewayService.waitForRunCompletion(sessionId);
            const backendSession = agentService.exportChatSession(sessionId);
            if (!backendSession) {
              throw new Error(`Session with ID ${sessionId} not found`);
            }
            const uiSession = uiHistoryService.getSession(sessionId);
            if (mode === "simple") {
              const markdown = uiHistoryService.toReadableMarkdown(
                uiSession?.messages || [],
                uiSession?.title || backendSession.title,
              );
              return {
                sessionId,
                mode,
                title: uiSession?.title || backendSession.title,
                content: markdown,
              };
            }
            return {
              sessionId: backendSession.id,
              mode,
              title: uiSession?.title || backendSession.title,
              lastCheckpointOffset: backendSession.lastCheckpointOffset,
              createdAt: new Date(backendSession.createdAt).toISOString(),
              updatedAt: new Date(backendSession.updatedAt).toISOString(),
              frontendMessages: uiSession?.messages || [],
              backendMessages: backendSession.messages.map((msg: any) => ({
                messageId: msg.id,
                messageType: msg.type,
                messageData: msg.data,
              })),
            };
          },
          getAllChatHistory: () => agentService.getAllChatHistory(),
          loadChatSession: (sessionId) =>
            agentService.loadChatSession(sessionId),
          getUiMessages: (sessionId) => uiHistoryService.getMessages(sessionId),
        },
        systemBridge: {
          saveImageAttachment: async (payload: {
            dataBase64: string;
            fileName?: string;
            mimeType?: string;
            previewDataUrl?: string;
          }) => {
            return await imageAttachmentService.saveImageAttachment(payload);
          },
        },
        skillBridge: {
          reload: async () => {
            return await skillService.reload();
          },
          getAll: async () => {
            return await skillService.getAll();
          },
          getEnabled: async () => {
            return await skillService.getEnabledSkills();
          },
          create: async () => {
            return await skillService.createSkillFromTemplate();
          },
          delete: async (fileName: string) => {
            await skillService.deleteSkillFile(fileName);
            return await skillService.getAll();
          },
          listSkills: async () => {
            const snapshot = settingsService.getSettings();
            const enabledMap = snapshot.tools?.skills ?? {};
            const skills = await skillService.getAll();
            return skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: enabledMap[skill.name] !== false,
            }));
          },
          setSkillEnabled: async (name: string, enabled: boolean) => {
            const snapshot = settingsService.getSettings();
            const nextSkills = { ...(snapshot.tools?.skills ?? {}) };
            nextSkills[name] = enabled;

            settingsService.setSettings({
              tools: {
                builtIn: snapshot.tools?.builtIn ?? {},
                skills: nextSkills,
              },
            });

            const next = settingsService.getSettings();
            agentService.updateSettings(next);
            const skills = await skillService.getAll();
            const summary = buildSkillStatusSummary(skills, next.tools?.skills);
            gatewayService.broadcastRaw("skills:updated", summary);
            return summary;
          },
        },
        memoryBridge: {
          get: async () => {
            return await memoryService.getMemorySnapshot(
              settingsService.getSettings().agentSettings?.activeProfileId ||
                null,
            );
          },
          setContent: async (content: string) => {
            const snapshot = await memoryService.writeMemory(
              content,
              settingsService.getSettings().agentSettings?.activeProfileId ||
                null,
            );
            gatewayService.broadcastRaw("memory:updated", snapshot);
            return snapshot;
          },
          search: async (query: string, limit?: number) => {
            const { content } = await memoryService.getMemorySnapshot(
              settingsService.getSettings().agentSettings?.activeProfileId || null,
            );
            return searchMemory(content, query, limit ?? 10);
          },
          append: async (note: string) => {
            const profileId =
              settingsService.getSettings().agentSettings?.activeProfileId || null;
            const { content } = await memoryService.getMemorySnapshot(profileId);
            const next = appendMemoryNote(content, note);
            const snapshot = await memoryService.writeMemory(next, profileId);
            gatewayService.broadcastRaw("memory:updated", snapshot);
            return snapshot;
          },
        },
        agentSettingsBridge: {
          get: () => agentSettingProfileService.getState(),
          saveCurrent: async () => {
            const result = await agentSettingProfileService.saveCurrent();
            broadcastAgentSettingResult(result);
            return result;
          },
          apply: async (profileId: string) => {
            const result = await agentSettingProfileService.apply(profileId);
            broadcastAgentSettingResult(result);
            return result;
          },
          overwrite: async (profileId: string) => {
            const result =
              await agentSettingProfileService.overwrite(profileId);
            broadcastAgentSettingResult(result);
            return result;
          },
          delete: async (profileId: string) => {
            const result = await agentSettingProfileService.delete(profileId);
            broadcastAgentSettingResult(result);
            return result;
          },
        },
        settingsBridge: {
          getSettings: () => settingsService.getSettings(),
          setSettings: async (patch) => {
            if ((patch as any)?.gateway?.ws) {
              throw new Error(
                "settings.gateway.ws is not configurable via websocket RPC.",
              );
            }
            settingsService.setSettings(patch as any);
            const next = settingsService.getSettings();
            agentService.updateSettings(next);
            return next;
          },
          // v3.2.18: settings backup/restore/export/import.
          listBackups: () => settingsBackupService.list(),
          restoreBackup: async (name: string) => settingsBackupService.restore(name),
          export: () => settingsBackupService.export(),
          import: async (content: string) => settingsBackupService.import(content),
        },
        // v3.2.18: cross-session history search.
        historyBridge: {
          getAllSessions: async () => {
            const history = agentService.getAllChatHistory() ?? [];
            return history;
          },
        },
        commandPolicyBridge: {
          getLists: async () => {
            return await commandPolicyService.getLists();
          },
          addRule: async (listName, rule) => {
            return await commandPolicyService.addRule(listName, rule);
          },
          deleteRule: async (listName, rule) => {
            return await commandPolicyService.deleteRule(listName, rule);
          },
        },
        toolsBridge: {
          reloadMcp: async () => {
            return await mcpToolService.reloadAll();
          },
          getMcp: () => mcpToolService.getSummaries(),
          setMcpEnabled: async (name, enabled) => {
            return await mcpToolService.setServerEnabled(name, enabled);
          },
          getBuiltIn: () => {
            const settings = settingsService.getSettings();
            return buildBuiltInToolStatusSummary(settings.tools?.builtIn);
          },
          setBuiltInEnabled: async (name, enabled) => {
            const settings = settingsService.getSettings();
            const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) };
            nextBuiltIn[name] = enabled;
            settingsService.setSettings({
              tools: {
                builtIn: nextBuiltIn,
                skills: settings.tools?.skills ?? {},
              },
            });
            const next = settingsService.getSettings();
            agentService.updateSettings(next);
            const summary = buildBuiltInToolStatusSummary(next.tools?.builtIn);
            gatewayService.broadcastRaw("tools:builtInUpdated", summary);
            return summary;
          },
        },
        // Observability bridge (v2.9.x): exposes the 9 platform capabilities
        // (metrics export, secrets, on-call, cost, recording, gitops, playbooks,
        // cloud, live dashboard) as observability:* RPC methods.
        observabilityBridge: createObservabilityBridge({
          observability: () => observability,
          terminalService: () => terminalService,
        }),
      });
      // v3.2.18: the REST routes dispatch through this adapter.
      restDispatchTarget = adapter as unknown as RestDispatchTarget;
      return adapter;
    },
  });
  await wsGatewayControlService.applyPolicy(startupPolicy);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gybackend] Received ${signal}, shutting down...`);
    try {
      await wsGatewayControlService.stop();
    } catch (error) {
      console.warn(
        "[gybackend] Failed to stop websocket adapter cleanly:",
        error,
      );
    }

    for (const terminal of terminalService.getDisplayTerminals()) {
      terminalService.kill(terminal.id);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.log("[gybackend] Started.");
  const wsState = wsGatewayControlService.getState();
  if (wsState.running && wsState.host) {
    console.log(
      `[gybackend] WebSocket RPC endpoint: ws://${wsState.host}:${wsState.port}`,
    );
    console.log(
      `[gybackend] Live dashboard: http://${wsState.host}:${wsState.port}/dashboard`,
    );
  } else {
    console.log("[gybackend] WebSocket RPC endpoint: disabled");
  }
  console.log(`[gybackend] Data directory: ${dataDir}`);
  console.log(
    `[gybackend] Settings file: ${settingsService.getSettingsPath()}`,
  );
  console.log(
    `[gybackend] Memory file: ${await memoryService.getMemoryFilePath()}`,
  );
  console.log(
    `[gybackend] Access token file: ${accessTokenService.getStorageFilePath()}`,
  );
}
