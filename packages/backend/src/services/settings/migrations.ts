import type { AlertsSettings, BackendSettings, CloudSettings, CostSettings, OncallSettings, WsGatewayAccess } from "../../types";
import { BUILTIN_TOOL_INFO } from "../AgentHelper/tools";
import { normalizeAgentSettingState } from "./agentSettings";
import { deepMerge, isObject } from "./objectMerge";

export const BACKEND_SETTINGS_SCHEMA_VERSION = 5;

const DEFAULT_BUILTIN_TOOLS = BUILTIN_TOOL_INFO.reduce(
  (acc: Record<string, boolean>, tool) => {
    acc[tool.name] = tool.defaultEnabled ?? true;
    return acc;
  },
  {},
);

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  schemaVersion: BACKEND_SETTINGS_SCHEMA_VERSION,
  commandPolicyMode: "standard",
  tools: {
    builtIn: DEFAULT_BUILTIN_TOOLS,
    skills: {},
  },
  model: "",
  baseUrl: "",
  apiKey: "",
  models: {
    items: [],
    profiles: [],
    activeProfileId: "",
  },
  connections: {
    ssh: [],
    winrm: [],
    serial: [],
    proxies: [],
    tunnels: [],
  },
  automation: {
    groups: [],
    deviceMemory: [],
    scripts: [],
    scheduledTasks: [],
    templates: [],
    playbooks: [],
  },
  sessionLogging: { enabled: false },
  cost: {
    modelPrices: {},
    budgets: [],
  },
  alerts: {
    channels: [],
  },
  oncall: {
    pagingChannels: [],
  },
  cloud: {
    accounts: [],
  },
  gateway: {
    ws: {
      access: "localhost",
      port: 17888,
      allowedCidrs: [],
    },
    mobileWeb: {
      port: null,
    },
  },
  layout: {
    panelSizes: [50, 50],
    panelOrder: ["chat", "terminal"],
    savedLayouts: [],
    activeSavedLayoutId: null,
  },
  recursionLimit: 200,
  memory: {
    enabled: true,
  },
  agentSettings: {
    profiles: [],
    activeProfileId: null,
  },
  debugMode: false,
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false,
    execCommandActionModelEnabled: true,
    writeStdinActionModelEnabled: true,
  },
};

function pickBackendSnapshot(raw: unknown): Partial<BackendSettings> {
  if (!isObject(raw)) return {};
  return {
    schemaVersion: raw.schemaVersion,
    commandPolicyMode: raw.commandPolicyMode,
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    models: raw.models,
    connections: raw.connections,
    tools: raw.tools,
    // automation (groups, scripts, scheduled tasks, templates, device memory)
    // and sessionLogging are first-class persisted settings — they must survive
    // migration. Omitting them here wiped the whole automation block (and the
    // session-logging flag) on every save/load, so groups/tasks disappeared
    // after a restart.
    automation: raw.automation,
    sessionLogging: raw.sessionLogging,
    cost: raw.cost,
    alerts: raw.alerts,
    oncall: raw.oncall,
    cloud: raw.cloud,
    gateway: raw.gateway,
    layout: raw.layout,
    recursionLimit: raw.recursionLimit,
    memory: raw.memory,
    agentSettings: raw.agentSettings,
    debugMode: raw.debugMode,
    experimental: raw.experimental,
  } as Partial<BackendSettings>;
}

function normalizeBackendSettings(settings: BackendSettings): BackendSettings {
  const next = deepMerge(DEFAULT_BACKEND_SETTINGS, settings);

  next.models.items = next.models.items.map((item) => ({
    ...item,
    maxTokens:
      typeof item.maxTokens === "number" && item.maxTokens > 0
        ? item.maxTokens
        : 200000,
    structuredOutputMode:
      item.structuredOutputMode === "on" || item.structuredOutputMode === "off"
        ? item.structuredOutputMode
        : "auto",
    supportsStructuredOutput: item.supportsStructuredOutput === true,
    supportsObjectToolChoice: item.supportsObjectToolChoice === true,
  }));

  const builtIn = { ...(next.tools?.builtIn ?? {}) };
  if (builtIn.send_char !== undefined && builtIn.write_stdin === undefined) {
    builtIn.write_stdin = builtIn.send_char;
  }
  delete builtIn.send_char;

  next.tools = {
    builtIn: {
      ...DEFAULT_BUILTIN_TOOLS,
      ...builtIn,
    },
    skills: {
      ...(next.tools?.skills ?? {}),
    },
  };

  if (!next.models.activeProfileId && next.models.profiles.length > 0) {
    next.models.activeProfileId = next.models.profiles[0].id;
  }

  const activeProfile = next.models.profiles.find(
    (profile) => profile.id === next.models.activeProfileId,
  );
  const activeModel = activeProfile
    ? next.models.items.find((item) => item.id === activeProfile.globalModelId)
    : undefined;

  next.model = activeModel?.model || "";
  next.baseUrl = activeModel?.baseUrl || "";
  next.apiKey = activeModel?.apiKey || "";

  next.recursionLimit =
    typeof next.recursionLimit === "number" &&
    Number.isFinite(next.recursionLimit) &&
    next.recursionLimit > 0
      ? next.recursionLimit
      : 200;

  next.memory = {
    enabled: next.memory?.enabled !== false,
  };

  next.agentSettings = normalizeAgentSettingState(next.agentSettings, {
    recursionLimit: next.recursionLimit,
    experimental: next.experimental ?? DEFAULT_BACKEND_SETTINGS.experimental!,
  });

  next.debugMode = next.debugMode === true;

  next.experimental = {
    runtimeThinkingCorrectionEnabled:
      next.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: next.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled:
      next.experimental?.firstTurnThinkingModelEnabled === true,
    execCommandActionModelEnabled:
      next.experimental?.execCommandActionModelEnabled !== false,
    writeStdinActionModelEnabled:
      next.experimental?.writeStdinActionModelEnabled !== false,
  };

  const access = next.gateway?.ws?.access;
  const normalizedAccess: WsGatewayAccess =
    access === "disabled" ||
    access === "internet" ||
    access === "localhost" ||
    access === "lan" ||
    access === "custom"
      ? access
      : "localhost";
  const port = Number(next.gateway?.ws?.port);
  const allowedCidrs = Array.isArray(next.gateway?.ws?.allowedCidrs)
    ? (next.gateway!.ws.allowedCidrs as string[])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s): s is string => s.length > 0)
    : [];

  const mobileWebPort = next.gateway?.mobileWeb?.port;
  const normalizedMobileWebPort =
    typeof mobileWebPort === "number" &&
    Number.isInteger(mobileWebPort) &&
    mobileWebPort > 0 &&
    mobileWebPort < 65536
      ? mobileWebPort
      : null;

  next.gateway = {
    ws: {
      access: normalizedAccess,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 17888,
      allowedCidrs,
    },
    mobileWeb: {
      port: normalizedMobileWebPort,
    },
  };

  next.cost = normalizeCostSettings(next.cost);
  next.alerts = normalizeAlertsSettings(next.alerts);
  next.oncall = normalizeOncallSettings(next.oncall);
  next.cloud = normalizeCloudSettings(next.cloud);

  next.schemaVersion = BACKEND_SETTINGS_SCHEMA_VERSION;
  return next;
}

/** Sanitize a price number (USD per 1M tokens): finite, >= 0, else 0. */
function priceNumber(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Normalize the AI cost block: coerce the price table to finite non-negative
 * numbers and drop malformed budgets so a hand-edited or partially-written
 * settings file can never crash cost attribution.
 */
export function normalizeCostSettings(raw: unknown): CostSettings {
  const src = isObject(raw) ? (raw as Record<string, unknown>) : {};
  const modelPrices: CostSettings["modelPrices"] = {};
  const rawPrices = isObject(src.modelPrices)
    ? (src.modelPrices as Record<string, unknown>)
    : {};
  for (const [model, entry] of Object.entries(rawPrices)) {
    if (!model || typeof model !== "string") continue;
    const e = isObject(entry) ? (entry as Record<string, unknown>) : {};
    modelPrices[model] = {
      promptPer1M: priceNumber(e.promptPer1M),
      completionPer1M: priceNumber(e.completionPer1M),
    };
  }

  const budgets: CostSettings["budgets"] = [];
  const rawBudgets = Array.isArray(src.budgets) ? src.budgets : [];
  for (const b of rawBudgets) {
    if (!isObject(b)) continue;
    const rec = b as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const capUsd = typeof rec.capUsd === "number" ? rec.capUsd : Number(rec.capUsd);
    if (!Number.isFinite(capUsd) || capUsd <= 0) continue;
    const period = rec.period === "monthly" ? "monthly" : "daily";
    const warnAt =
      typeof rec.warnAt === "number" && Number.isFinite(rec.warnAt) && rec.warnAt > 0 && rec.warnAt <= 1
        ? rec.warnAt
        : undefined;
    const overAction = rec.overAction === "deny" ? "deny" : rec.overAction === "throttle" ? "throttle" : undefined;
    const model = typeof rec.model === "string" && rec.model.trim() ? rec.model.trim() : undefined;
    const profileId = typeof rec.profileId === "string" && rec.profileId.trim() ? rec.profileId.trim() : undefined;
    budgets.push({ id, model, profileId, period, capUsd, warnAt, overAction });
  }

  return { modelPrices, budgets };
}

const ALERT_TYPES = new Set(["slack", "teams", "smtp", "telegram"]);
const ALERT_SEVERITIES = new Set(["info", "warning", "critical"]);

/**
 * Normalize the alert-channels block: keep only well-formed channels and coerce
 * fields. Secrets are never validated here (they live in the vault); only the
 * secretRef pointer + routing fields are checked.
 */
export function normalizeAlertsSettings(raw: unknown): AlertsSettings {
  const src = isObject(raw) ? (raw as Record<string, unknown>) : {};
  const rawChannels = Array.isArray(src.channels) ? src.channels : [];
  const channels: AlertsSettings["channels"] = [];
  for (const c of rawChannels) {
    if (!isObject(c)) continue;
    const rec = c as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const type = ALERT_TYPES.has(rec.type as string)
      ? (rec.type as AlertsSettings["channels"][number]["type"])
      : "slack";
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    const minSeverity = ALERT_SEVERITIES.has(rec.minSeverity as string)
      ? (rec.minSeverity as AlertsSettings["channels"][number]["minSeverity"])
      : undefined;
    const secretRef = typeof rec.secretRef === "string" && rec.secretRef.trim() ? rec.secretRef.trim() : undefined;
    const chatId = typeof rec.chatId === "string" && rec.chatId.trim() ? rec.chatId.trim() : undefined;
    let smtp: AlertsSettings["channels"][number]["smtp"];
    if (isObject(rec.smtp)) {
      const s = rec.smtp as Record<string, unknown>;
      const host = typeof s.host === "string" ? s.host.trim() : "";
      const portRaw = typeof s.port === "number" ? s.port : Number(s.port);
      const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 587;
      const from = typeof s.from === "string" ? s.from.trim() : "";
      const to = Array.isArray(s.to) ? s.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
      if (host && from && to.length) {
        smtp = {
          host,
          port,
          secure: s.secure === true,
          user: typeof s.user === "string" && s.user.trim() ? s.user.trim() : undefined,
          from,
          to,
        };
      }
    }
    channels.push({
      id,
      name,
      type,
      enabled: rec.enabled !== false,
      ...(minSeverity ? { minSeverity } : {}),
      ...(secretRef ? { secretRef } : {}),
      ...(chatId ? { chatId } : {}),
      ...(smtp ? { smtp } : {}),
    });
  }
  return { channels };
}

const PAGING_TYPES = new Set(["slack", "teams", "smtp", "telegram", "webhook"]);

/** Normalize an smtp sub-config; returns undefined when incomplete. */
function normalizeSmtp(raw: unknown): OncallSettings["pagingChannels"][number]["smtp"] {
  if (!isObject(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const host = typeof s.host === "string" ? s.host.trim() : "";
  const portRaw = typeof s.port === "number" ? s.port : Number(s.port);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 587;
  const from = typeof s.from === "string" ? s.from.trim() : "";
  const to = Array.isArray(s.to) ? s.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  if (!host || !from || !to.length) return undefined;
  return {
    host,
    port,
    secure: s.secure === true,
    user: typeof s.user === "string" && s.user.trim() ? s.user.trim() : undefined,
    from,
    to,
  };
}

/**
 * Normalize the on-call paging-channels block: keep only well-formed channels,
 * coerce fields, and never inline secrets (only the secretRef pointer).
 */
export function normalizeOncallSettings(raw: unknown): OncallSettings {
  const src = isObject(raw) ? (raw as Record<string, unknown>) : {};
  const rawChannels = Array.isArray(src.pagingChannels) ? src.pagingChannels : [];
  const pagingChannels: OncallSettings["pagingChannels"] = [];
  for (const c of rawChannels) {
    if (!isObject(c)) continue;
    const rec = c as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const type = PAGING_TYPES.has(rec.type as string)
      ? (rec.type as OncallSettings["pagingChannels"][number]["type"])
      : "webhook";
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    const minSeverity = ALERT_SEVERITIES.has(rec.minSeverity as string)
      ? (rec.minSeverity as OncallSettings["pagingChannels"][number]["minSeverity"])
      : undefined;
    const secretRef = typeof rec.secretRef === "string" && rec.secretRef.trim() ? rec.secretRef.trim() : undefined;
    const chatId = typeof rec.chatId === "string" && rec.chatId.trim() ? rec.chatId.trim() : undefined;
    const webhookUrl = typeof rec.webhookUrl === "string" && rec.webhookUrl.trim() ? rec.webhookUrl.trim() : undefined;
    const smtp = normalizeSmtp(rec.smtp);
    pagingChannels.push({
      id,
      name,
      type,
      enabled: rec.enabled !== false,
      ...(minSeverity ? { minSeverity } : {}),
      ...(secretRef ? { secretRef } : {}),
      ...(chatId ? { chatId } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(smtp ? { smtp } : {}),
    });
  }
  return { pagingChannels };
}

const CLOUD_PROVIDERS = new Set(["aws", "gcp", "azure"]);

/**
 * Normalize the cloud-inventory accounts block: keep only well-formed accounts
 * (valid provider + non-empty accountId) and never inline credentials (only the
 * secretRef pointer to the vault).
 */
export function normalizeCloudSettings(raw: unknown): CloudSettings {
  const src = isObject(raw) ? (raw as Record<string, unknown>) : {};
  const rawAccounts = Array.isArray(src.accounts) ? src.accounts : [];
  const accounts: CloudSettings["accounts"] = [];
  for (const a of rawAccounts) {
    if (!isObject(a)) continue;
    const rec = a as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const provider = CLOUD_PROVIDERS.has(rec.provider as string)
      ? (rec.provider as CloudSettings["accounts"][number]["provider"])
      : "aws";
    const accountId = typeof rec.accountId === "string" && rec.accountId.trim() ? rec.accountId.trim() : "";
    if (!accountId) continue;
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : accountId;
    const region = typeof rec.region === "string" && rec.region.trim() ? rec.region.trim() : undefined;
    const secretRef = typeof rec.secretRef === "string" && rec.secretRef.trim() ? rec.secretRef.trim() : undefined;
    accounts.push({
      id,
      provider,
      name,
      accountId,
      ...(region ? { region } : {}),
      ...(secretRef ? { secretRef } : {}),
      enabled: rec.enabled !== false,
    });
  }
  return { accounts };
}

function migrateBackendToV3(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  delete (next as any).language;
  delete (next as any).themeId;
  delete (next as any).terminal;
  next.schemaVersion = 3;
  return next;
}

function migrateBackendToV4(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  next.agentSettings = isObject(next.agentSettings)
    ? next.agentSettings
    : { profiles: [], activeProfileId: null };
  next.schemaVersion = 4;
  return next;
}

function migrateBackendToV5(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  next.cost = isObject(next.cost) ? next.cost : { modelPrices: {}, budgets: [] };
  next.schemaVersion = 5;
  return next;
}

export function migrateBackendSettings(
  raw: unknown,
  legacyRaw?: unknown,
): BackendSettings {
  const legacySnapshot = pickBackendSnapshot(legacyRaw);
  const rawSnapshot = pickBackendSnapshot(raw);

  const rawVersion =
    isObject(raw) && typeof raw.schemaVersion === "number"
      ? raw.schemaVersion
      : 0;
  const legacyVersion =
    isObject(legacyRaw) && typeof legacyRaw.schemaVersion === "number"
      ? legacyRaw.schemaVersion
      : 0;

  let merged = deepMerge(DEFAULT_BACKEND_SETTINGS, legacySnapshot);
  merged = deepMerge(merged, rawSnapshot);

  const fromVersion = Math.max(rawVersion, legacyVersion);
  if (fromVersion < 3) {
    merged = deepMerge(merged, migrateBackendToV3(merged as any) as any);
  }
  if (fromVersion < 4) {
    merged = deepMerge(merged, migrateBackendToV4(merged as any) as any);
  }
  if (fromVersion < 5) {
    merged = deepMerge(merged, migrateBackendToV5(merged as any) as any);
  }

  return normalizeBackendSettings(merged);
}
