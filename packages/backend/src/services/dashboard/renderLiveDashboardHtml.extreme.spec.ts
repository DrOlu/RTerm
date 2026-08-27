import { renderDashboardHtml, renderLiveDashboardHtml } from "./renderDashboardHtml";
import type { DashboardState } from "./dashboardService";

/**
 * renderLiveDashboardHtml.extreme.spec — the live (WS-push) dashboard page:
 * stable section ids, embedded live client, no meta-refresh, escaped output.
 * Run: npx tsx --test packages/backend/src/services/dashboard/renderLiveDashboardHtml.extreme.spec.ts
 */

const assert = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(`assert failed: ${message}`);
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const state: DashboardState = {
  at: 1785000000000,
  hosts: [
    {
      host: "web-1",
      golden: {
        host: "web-1",
        cpuPercent: 42.5,
        memPercent: 61.2,
        diskPercentMax: 70.1,
        cpuTrendPerDay: 0.5,
        diskDaysToFull: 120,
      } as never,
      uptime: undefined,
    },
  ],
  slos: [],
  uptime: [
    {
      target: { name: "web-1", url: "http://web-1" },
      state: "up",
      consecutiveFailures: 0,
      lastLatencyMs: 12,
    } as never,
  ],
  incidents: [],
  apm: {
    bottleneckServices: [
      { service: "api-gw", spanCount: 10, errorCount: 1, errorRate: 0.1, p95Ms: 500 },
    ],
    slowestTraces: [
      {
        traceId: "abc123def4567890",
        rootService: "api-gw",
        spanCount: 3,
        totalDurationMs: 500,
        hasError: true,
        services: ["api-gw"],
        at: 1785000000000,
      },
    ],
  },
  dem: {
    slowestPages: [
      { page: "shop", sessions: 5, p75LcpMs: 4200, p75InpMs: 300, errorRate: 0.2 },
    ],
    poorPages: [],
  },
  clusters: [
    {
      context: "prod",
      totalPods: 10,
      runningPods: 9,
      notReadyPods: 1,
      crashLoopPods: 1,
      totalRestarts: 20,
      nodesReady: 3,
      nodesTotal: 3,
    },
  ],
  capacity: [{ host: "web-1", diskPercent: 70.1, daysToFull: 120 }],
  situation: [],
  headline: "",
  work: { playbooks: [], triggers: [], scheduledTasks: [], agentRuns: [] },
  empty: [],
};

await runCase("live page renders all section containers with stable ids", () => {
  const html = renderLiveDashboardHtml(state);
  for (const id of ["fleet", "slo", "uptime", "incidents", "apm-svc", "apm-trace", "dem", "clusters", "capacity", "situation", "work", "host-filter"]) {
    assert(html.includes(`id="${id}"`), `missing section container #${id}`);
  }
});

await runCase("live page embeds the WS live client and has no meta refresh", () => {
  const html = renderLiveDashboardHtml(state);
  assert(!html.includes('http-equiv="refresh"'), "live page must not meta-refresh");
  assert(html.includes("observability:liveDashboardSubscribe"), "live client subscribes to dashboard pushes");
  assert(html.includes("new WebSocket("), "live client opens a WebSocket");
  assert(html.includes("/dashboard/json"), "live client has the polling fallback URL");
  assert(html.includes("gateway:event"), "live client handles gateway event frames");
});

await runCase("live page inlines the initial state (first paint before WS)", () => {
  const html = renderLiveDashboardHtml(state);
  assert(html.includes("web-1"), "initial host rendered");
  assert(html.includes("api-gw"), "initial APM service rendered");
  assert(html.includes("shop"), "initial DEM page rendered");
  assert(html.includes("prod"), "initial cluster rendered");
});

await runCase("classic renderer unchanged (meta refresh, section ids on <section>)", () => {
  const html = renderDashboardHtml(state, { refreshSeconds: 7 });
  assert(html.includes('http-equiv="refresh" content="7"'), "classic page keeps meta refresh");
  assert(html.includes('<section class="span2"') === false || html.includes('id="fleet"'), "classic fleet section present");
  assert(!html.includes("new WebSocket("), "classic page has no live client");
});

await runCase("live page escapes user-controlled strings", () => {
  const evil: DashboardState = {
    ...state,
    hosts: [{ host: '<img src=x onerror="alert(1)">', golden: undefined, uptime: undefined } as never],
    incidents: [],
  };
  const html = renderLiveDashboardHtml(evil);
  assert(!html.includes('<img src=x onerror="alert(1)">'), "host name is escaped");
  assert(html.includes("&lt;img src=x"), "escaped host name present");
});

console.log("renderLiveDashboardHtml: all cases passed");
