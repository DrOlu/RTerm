/**
 * hostConcurrency.extreme.spec — v3.4.2 per-host concurrency + fair queue.
 *
 * Covers the deadlock/fairness/abort bugs found while auditing the first
 * draft of the limiter, plus the host-keying FN (TerminalTab has no config
 * field — the config must be fetched from the terminal service).
 *
 * Run: npx tsx packages/backend/src/services/AgentHelper/tools/hostConcurrency.extreme.spec.ts
 */
import {
  HostConcurrency,
  hostKeyForTab,
  getDefaultHostConcurrency,
  setDefaultHostConcurrency,
} from "./hostConcurrency";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: unknown, label: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n== 1. Per-host cap: 3 concurrent max on one host ==");

  {
    const limiter = new HostConcurrency({ perHost: 3, global: 12 });
    let peak = 0;
    let running = 0;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limiter.run("host-a", async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(20);
          running--;
          return i;
        }, `op-${i}`),
      ),
    );
    assert(peak === 3, `peak concurrency on one host = 3 (got ${peak})`);
  }

  console.log("\n== 2. Global cap across distinct hosts ==");

  {
    const limiter = new HostConcurrency({ perHost: 5, global: 4 });
    let peak = 0;
    let running = 0;
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        limiter.run(`host-${i}`, async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(20);
          running--;
        }, `op-${i}`),
      ),
    );
    assert(peak === 4, `global peak = 4 (got ${peak})`);
  }

  console.log("\n== 3. THE DEADLOCK REGRESSION: no double-acquire on grant ==");

  {
    const limiter = new HostConcurrency({ perHost: 2, global: 2 });
    let peak = 0;
    let running = 0;
    // 8 ops on one host with perHost=2 — the queued path (pump grant) runs.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run("h", async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(10);
          running--;
        }),
      ),
    );
    assert(peak === 2, `queued grants must not double-acquire (peak ${peak}, want 2)`);
    assert(limiter.globalRunningCount === 0, `counters drain to 0 (got ${limiter.globalRunningCount})`);
    // After the burst the limiter must be fully usable again (no saturation).
    let ok = false;
    await limiter.run("h", async () => { ok = true; });
    assert(ok, "limiter still admits new work after a heavy burst");
  }

  console.log("\n== 4. FIFO fairness: no queue-jumping ==");

  {
    const limiter = new HostConcurrency({ perHost: 1, global: 1 });
    const order: string[] = [];
    // Hold the slot, then enqueue 3 waiters, then a 4th that must NOT jump.
    const holder = limiter.run("h", async () => {
      await sleep(30);
      order.push("first");
    });
    await sleep(5); // let it start
    const p2 = limiter.run("h", async () => { order.push("second"); });
    const p3 = limiter.run("h", async () => { order.push("third"); });
    const p4 = limiter.run("h", async () => { order.push("fourth"); });
    await Promise.all([holder, p2, p3, p4]);
    assert(
      order.join(",") === "first,second,third,fourth",
      `strict FIFO order (got ${order.join(",")})`,
    );
  }

  console.log("\n== 5. Abort while queued releases the slot ==");

  {
    const limiter = new HostConcurrency({ perHost: 1, global: 1 });
    const ctrl = new AbortController();
    const done: string[] = [];
    const holder = limiter.run("h", async () => { await sleep(40); done.push("holder"); });
    await sleep(5);
    const queued = limiter.run("h", async () => { done.push("should-not-run"); }, "queued", { signal: ctrl.signal });
    await sleep(5);
    ctrl.abort();
    let aborted = false;
    try { await queued; } catch { aborted = true; }
    assert(aborted, "queued op rejects on abort");
    await holder;
    assert(limiter.globalRunningCount === 0, "no counter leak after abort");
    // The aborted op must not run later.
    await sleep(10);
    assert(!done.includes("should-not-run"), "aborted op never executes");
  }

  console.log("\n== 6. Queue timeout does not corrupt counters ==");

  {
    const limiter = new HostConcurrency({ perHost: 1, global: 1, queueTimeoutMs: 30 });
    let err: Error | null = null;
    const holder = limiter.run("h", async () => { await sleep(80); });
    await sleep(5);
    try {
      await limiter.run("h", async () => {}, "times-out");
    } catch (e) {
      err = e as Error;
    }
    assert(err !== null && /timeout/.test(err.message), "queued op times out");
    await holder;
    assert(limiter.globalRunningCount === 0, "counters clean after timeout");
    let ok = false;
    await limiter.run("h", async () => { ok = true; });
    assert(ok, "limiter healthy after a timeout");
  }

  console.log("\n== 7. Host keying: same host groups, different hosts don't ==");

  {
    const limiter = new HostConcurrency({ perHost: 2, global: 12 });
    let peakA = 0, runningA = 0;
    let peakB = 0, runningB = 0;
    // 6 ops on host A and 6 on host B — each host caps at 2, independently.
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        limiter.run("10.0.0.1", async () => {
          runningA++; peakA = Math.max(peakA, runningA);
          await sleep(25); runningA--;
        })),
      ...Array.from({ length: 6 }, () =>
        limiter.run("10.0.0.2", async () => {
          runningB++; peakB = Math.max(peakB, runningB);
          await sleep(25); runningB--;
        })),
    ]);
    assert(peakA === 2, `host A capped at 2 (got ${peakA})`);
    assert(peakB === 2, `host B capped at 2 (got ${peakB})`);
  }

  console.log("\n== 8. hostKeyForTab: config keying + fallbacks ==");

  {
    assert(
      hostKeyForTab({ id: "t1" }, { host: "Server.Example.COM" }) === "server.example.com",
      "ssh config host is lowercased key",
    );
    assert(
      hostKeyForTab({ id: "t2", type: "winrm" }, { host: "52.3.242.251" }) === "52.3.242.251",
      "winrm host keys by address",
    );
    assert(
      hostKeyForTab({ id: "t3" }, { path: "/dev/ttyUSB0" }) === "serial:/dev/ttyUSB0",
      "serial keys by device path (case preserved — device paths are case-sensitive)",
    );
    assert(hostKeyForTab({ id: "t4", type: "local" }, null) === "local", "local tab → shared 'local' bucket");
    assert(hostKeyForTab({ id: "t5" }, null) === "tab:t5", "no config → per-tab fallback (never groups wrong hosts)");
    // Two tabs, same host → same key (THE FIX that makes the cap meaningful).
    const k1 = hostKeyForTab({ id: "a" }, { host: "44.197.31.152" });
    const k2 = hostKeyForTab({ id: "b" }, { host: "44.197.31.152" });
    assert(k1 === k2, "two tabs on one host share a bucket");
  }

  console.log("\n== 9. Stats are observable ==");

  {
    const limiter = new HostConcurrency({ perHost: 1, global: 1 });
    const hold = limiter.run("stats-host", async () => { await sleep(50); });
    await sleep(5);
    const queuedP = limiter.run("stats-host", async () => {}, "queued");
    await sleep(5);
    const s = limiter.stats().find((x) => x.host === "stats-host");
    assert(s?.running === 1 && s.queued === 1, `stats show running=1 queued=1 (got ${JSON.stringify(s)})`);
    assert(limiter.globalQueuedCount === 1, "globalQueuedCount = 1");
    await hold;
    await queuedP;
  }

  console.log("\n== 11. Abort BEFORE start: fast path rejects, no slot consumed ==");

  {
    // v3.4.3: the fast path previously skipped the abort check entirely, so
    // an already-cancelled fleet run still fired its commands at the host.
    const limiter = new HostConcurrency({ perHost: 3, global: 12 });
    const ctrl = new AbortController();
    ctrl.abort();
    let ran = false;
    let rejected = false;
    try {
      await limiter.run("h", async () => { ran = true; }, "already-aborted", { signal: ctrl.signal });
    } catch (e: any) {
      rejected = e?.name === "AbortError";
    }
    assert(rejected, "pre-aborted op rejects with an AbortError");
    assert(!ran, "pre-aborted op never executes fn");
    assert(limiter.globalRunningCount === 0, "pre-aborted op consumed no slot");
  }

  console.log("\n== 12. Abort while queued is recognisable by isAbortError ==");

  {
    // v3.4.3: the queue-abort used a plain Error, so isAbortError() missed it
    // and runOnOneTab reported a per-target FAIL row instead of propagating
    // the cancel. It must now carry name === 'AbortError'.
    const limiter = new HostConcurrency({ perHost: 1, global: 1 });
    const ctrl = new AbortController();
    const holder = limiter.run("h", async () => { await sleep(40); });
    await sleep(5);
    const queued = limiter.run("h", async () => {}, "queued", { signal: ctrl.signal });
    await sleep(5);
    ctrl.abort();
    let name = "";
    try { await queued; } catch (e: any) { name = e?.name ?? ""; }
    assert(name === "AbortError", `queue-abort error name is AbortError (got ${JSON.stringify(name)})`);
    await holder;
    assert(limiter.globalRunningCount === 0, "counters clean after queue-abort");
  }

  console.log("\n== 10. Default instance + reset hook ==");

  {
    const a = getDefaultHostConcurrency();
    const b = getDefaultHostConcurrency();
    assert(a === b, "default instance is a singleton");
    const custom = new HostConcurrency({ perHost: 7 });
    setDefaultHostConcurrency(custom);
    assert(getDefaultHostConcurrency() === custom, "setDefaultHostConcurrency replaces it");
    setDefaultHostConcurrency(null);
    assert(getDefaultHostConcurrency() !== custom, "null resets to a fresh singleton");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("hostConcurrency: ALL TESTS PASSED");
}

main().catch((e) => {
  console.error("spec crashed:", e);
  process.exit(1);
});
