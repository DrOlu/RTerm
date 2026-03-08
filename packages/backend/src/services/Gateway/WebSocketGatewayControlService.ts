import type { WsGatewayAccess } from "../../types";
import {
  WebSocketGatewayAdapter,
  type IWebSocketGatewayAdapterLogger,
} from "./WebSocketGatewayAdapter";

export interface WebSocketGatewayPolicy {
  access: WsGatewayAccess;
  port: number;
  /**
   * Optional host override for legacy env compatibility.
   * If absent, host is derived from access mode.
   */
  hostOverride?: string;
  allowedCidrs?: string[];
}

export interface WebSocketGatewayState {
  running: boolean;
  access: WsGatewayAccess;
  port: number;
  host?: string;
  allowedCidrs?: string[];
}

export interface WebSocketGatewayControlServiceOptions {
  createAdapter: (
    host: string,
    port: number,
    ipFilter?: import("./WebSocketGatewayAdapter").WebSocketIpFilter,
  ) => WebSocketGatewayAdapter;
  logger?: IWebSocketGatewayAdapterLogger;
}

export interface ResolvePolicyFromEnvOptions {
  env: NodeJS.ProcessEnv;
  defaultPolicy: WebSocketGatewayPolicy;
  hostVarName: string;
  portVarName: string;
  enableVarName?: string;
}

function normalizeAllowedCidrs(
  rawAllowedCidrs: string[] | undefined,
): string[] {
  if (!Array.isArray(rawAllowedCidrs)) {
    return [];
  }
  return rawAllowedCidrs
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function resolveAccessWithHostOverride(
  defaultAccess: WsGatewayAccess,
  resolvedHostAccess: WsGatewayAccess,
): WsGatewayAccess {
  if (resolvedHostAccess === "localhost") {
    return "localhost";
  }
  if (defaultAccess === "lan" || defaultAccess === "custom") {
    return defaultAccess;
  }
  return "internet";
}

export function resolveWsGatewayAccessFromHost(
  hostRaw: string,
): WsGatewayAccess {
  const host = hostRaw.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return "localhost";
  }
  return "internet";
}

export function resolveWsGatewayHost(access: WsGatewayAccess): string {
  if (access === "localhost") return "127.0.0.1";
  if (access === "internet" || access === "lan" || access === "custom")
    return "0.0.0.0";
  throw new Error("Disabled access does not map to a host.");
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value >= 65536) {
    return fallback;
  }
  return value;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

export function resolveWsGatewayPolicyFromEnv(
  options: ResolvePolicyFromEnvOptions,
): WebSocketGatewayPolicy {
  const { env, defaultPolicy, hostVarName, portVarName, enableVarName } =
    options;
  const port = parsePort(env[portVarName], defaultPolicy.port);
  const enabled = enableVarName ? parseBoolean(env[enableVarName]) : undefined;

  if (enabled === false) {
    return { access: "disabled", port };
  }

  const hostRaw = (env[hostVarName] || "").trim();
  if (hostRaw) {
    const resolvedHostAccess = resolveWsGatewayAccessFromHost(hostRaw);
    return {
      access: resolveAccessWithHostOverride(
        defaultPolicy.access,
        resolvedHostAccess,
      ),
      port,
      hostOverride: hostRaw,
      allowedCidrs: defaultPolicy.allowedCidrs,
    };
  }

  if (enabled === true && defaultPolicy.access === "disabled") {
    return {
      access: "localhost",
      port,
    };
  }

  return {
    access: defaultPolicy.access,
    port,
    allowedCidrs: defaultPolicy.allowedCidrs,
  };
}

export class WebSocketGatewayControlService {
  private adapter: WebSocketGatewayAdapter | null = null;
  private current: WebSocketGatewayState = {
    running: false,
    access: "disabled",
    port: 17888,
  };
  private readonly logger: IWebSocketGatewayAdapterLogger;

  constructor(private readonly options: WebSocketGatewayControlServiceOptions) {
    this.logger = options.logger ?? console;
  }

  getState(): WebSocketGatewayState {
    return { ...this.current };
  }

  async applyPolicy(
    nextPolicy: WebSocketGatewayPolicy,
  ): Promise<WebSocketGatewayState> {
    const normalized = this.normalizePolicy(nextPolicy);
    if (normalized.access === "disabled") {
      await this.stop();
      this.current = {
        running: false,
        access: "disabled",
        port: normalized.port,
      };
      return this.getState();
    }

    const nextHost =
      normalized.hostOverride || resolveWsGatewayHost(normalized.access);
    if (
      this.current.running &&
      this.current.access === normalized.access &&
      this.current.port === normalized.port &&
      this.current.host === nextHost &&
      JSON.stringify(this.current.allowedCidrs) ===
        JSON.stringify(normalized.allowedCidrs)
    ) {
      return this.getState();
    }

    await this.stop();

    const ipFilter = this.resolveIpFilter(normalized);
    const nextAdapter = this.options.createAdapter(
      nextHost,
      normalized.port,
      ipFilter,
    );
    nextAdapter.start();
    this.adapter = nextAdapter;
    this.current = {
      running: true,
      access: normalized.access,
      port: normalized.port,
      host: nextHost,
      allowedCidrs: normalized.allowedCidrs,
    };
    this.logger.info(
      `[WebSocketGatewayControlService] Active ws://${nextHost}:${normalized.port} (${normalized.access})`,
    );
    return this.getState();
  }

  async stop(): Promise<void> {
    if (!this.adapter) return;
    const active = this.adapter;
    this.adapter = null;
    await active.stop();
    this.current = {
      running: false,
      access: "disabled",
      port: this.current.port,
    };
    this.logger.info("[WebSocketGatewayControlService] Stopped.");
  }

  private resolveIpFilter(
    policy: WebSocketGatewayPolicy,
  ): import("./WebSocketGatewayAdapter").WebSocketIpFilter | undefined {
    if (policy.access === "lan") {
      return { mode: "lan", allowedCidrs: [] };
    }
    if (policy.access === "custom") {
      return { mode: "custom", allowedCidrs: policy.allowedCidrs ?? [] };
    }
    return undefined;
  }

  private normalizePolicy(
    policy: WebSocketGatewayPolicy,
  ): WebSocketGatewayPolicy {
    const access = policy.access;
    if (
      access !== "disabled" &&
      access !== "localhost" &&
      access !== "internet" &&
      access !== "lan" &&
      access !== "custom"
    ) {
      throw new Error(
        `Invalid websocket access mode: ${String(policy.access)}`,
      );
    }
    const port = Number(policy.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(`Invalid websocket port: ${String(policy.port)}`);
    }
    const hostOverride = (policy.hostOverride || "").trim();
    const allowedCidrs = normalizeAllowedCidrs(policy.allowedCidrs);
    if (access === "custom" && allowedCidrs.length === 0) {
      throw new Error(
        "Custom websocket access mode requires at least one allowed CIDR.",
      );
    }
    return {
      access,
      port,
      hostOverride: hostOverride || undefined,
      allowedCidrs,
    };
  }
}
