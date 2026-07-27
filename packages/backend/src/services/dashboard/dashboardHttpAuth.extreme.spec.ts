import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  dashboardHttpAuthorized,
  extractDashboardToken,
  isLoopbackAddress,
} from "./dashboardHttpAuth";

/**
 * dashboardHttpAuth.extreme.spec — the shared /dashboard auth check (loopback
 * open, remote needs a token) + a regression guard that BOTH the gybackend and
 * the Electron main runtimes wire the dashboard httpRoutes (the v3.0.2 bug was
 * that Electron didn't → "Upgrade Required" on the desktop app).
 * Run: npx tsx --test packages/backend/src/services/dashboard/dashboardHttpAuth.extreme.spec.ts
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

const here = dirname(fileURLToPath(import.meta.url));

await runCase("isLoopbackAddress recognizes loopback forms", () => {
  for (const a of ["127.0.0.1", "127.0.1.5", "::1", "::ffff:127.0.0.1", "", "localhost"]) {
    assert(isLoopbackAddress(a), `expected loopback: "${a}"`);
  }
  for (const a of ["10.0.0.5", "192.168.1.91", "8.8.8.8", "example.com"]) {
    assert(!isLoopbackAddress(a), `expected NOT loopback: "${a}"`);
  }
});

await runCase("extractDashboardToken reads Bearer, x-access-token, and query param", () => {
  assert(
    extractDashboardToken({ headers: { authorization: "Bearer tok-1" } }) === "tok-1",
    "bearer token",
  );
  assert(
    extractDashboardToken({ headers: { "x-access-token": "tok-2" } }) === "tok-2",
    "header token",
  );
  assert(
    extractDashboardToken({ headers: {}, url: "/dashboard?access_token=tok-3" }) === "tok-3",
    "query token",
  );
  assert(extractDashboardToken({ headers: {} }) === "", "no token → empty");
});

await runCase("dashboardHttpAuthorized: loopback always allowed (no token)", async () => {
  const ok = await dashboardHttpAuthorized(
    { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    () => {
      throw new Error("verifyToken must not be called for loopback");
    },
  );
  assert(ok === true, "loopback allowed without token");
});

await runCase("dashboardHttpAuthorized: remote needs a valid token", async () => {
  const verify = (t: string) => t === "good";
  // no token
  assert(
    (await dashboardHttpAuthorized(
      { headers: {}, socket: { remoteAddress: "10.0.0.5" } },
      verify,
    )) === false,
    "remote without token denied",
  );
  // bad token
  assert(
    (await dashboardHttpAuthorized(
      { headers: { authorization: "Bearer bad" }, socket: { remoteAddress: "10.0.0.5" } },
      verify,
    )) === false,
    "remote with bad token denied",
  );
  // good token
  assert(
    (await dashboardHttpAuthorized(
      { headers: { authorization: "Bearer good" }, socket: { remoteAddress: "10.0.0.5" } },
      verify,
    )) === true,
    "remote with good token allowed",
  );
  // verifier throws → deny (fail closed)
  assert(
    (await dashboardHttpAuthorized(
      { headers: { authorization: "Bearer good" }, socket: { remoteAddress: "10.0.0.5" } },
      () => {
        throw new Error("vault locked");
      },
    )) === false,
    "verifier error → denied (fail closed)",
  );
});

// ── Regression guard: both runtimes must wire the dashboard routes ──────────
// v3.0.2 shipped the routes only in startGyBackend.ts; the desktop app uses
// startElectronMain.ts and got "Upgrade Required". Guard both stay wired.
await runCase("regression: gybackend + electron main both wire /dashboard httpRoutes", () => {
  const gy = readFileSync(
    join(here, "../../runtimes/gybackend/startGyBackend.ts"),
    "utf8",
  );
  const el = readFileSync(
    join(here, "../../../../electron/src/main/startElectronMain.ts"),
    "utf8",
  );
  for (const [name, src] of [["gybackend", gy], ["electron", el]] as const) {
    assert(src.includes("httpRoutes"), `${name}: httpRoutes missing`);
    assert(src.includes('"/dashboard"'), `${name}: /dashboard route missing`);
    assert(src.includes('"/dashboard/json"'), `${name}: /dashboard/json route missing`);
    assert(src.includes("renderLiveDashboardHtml"), `${name}: live renderer not used`);
    assert(src.includes("dashboardHttpAuthorized"), `${name}: shared auth helper not used`);
  }
});

console.log("dashboardHttpAuth: all cases passed");
