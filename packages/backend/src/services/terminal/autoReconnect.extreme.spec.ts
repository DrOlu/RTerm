import { AutoReconnect } from "./autoReconnect";

/**
 * autoReconnect.extreme.spec — backoff math, scheduling, cancellation, give-up.
 * Run: npx tsx --test packages/backend/src/services/terminal/autoReconnect.extreme.spec.ts
 */

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`);
};

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

/** A controllable fake clock for timers. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (h: unknown): void => {
      pending.delete(h as number);
    },
    fire: (h: number): void => {
      const t = pending.get(h);
      if (t) {
        pending.delete(h);
        t.fn();
      }
    },
    pendingCount: (): number => pending.size,
    lastHandle: (): number => nextId - 1,
  };
}

await runCase("delayForAttempt: exponential backoff capped at maxDelay", () => {
  const r = new AutoReconnect({ baseDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0 });
  assert(r.delayForAttempt(1) === 1000, "attempt 1 = base");
  assert(r.delayForAttempt(2) === 2000, "attempt 2 = 2x");
  assert(r.delayForAttempt(3) === 4000, "attempt 3 = 4x");
  assert(r.delayForAttempt(4) === 8000, "attempt 4 = 8x (cap)");
  assert(r.delayForAttempt(10) === 8000, "attempt 10 still capped");
});

await runCase("delayForAttempt: jitter stays within ±ratio", () => {
  // random()=1 → +ratio; random()=0 → -ratio
  const hi = new AutoReconnect({ baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2, random: () => 1 });
  const lo = new AutoReconnect({ baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2, random: () => 0 });
  assert(hi.delayForAttempt(1) === 1200, "max jitter up");
  assert(lo.delayForAttempt(1) === 800, "max jitter down");
});

await runCase("schedule fires onAttempt and tracks attempts", () => {
  const t = fakeTimers();
  const r = new AutoReconnect({ baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn });
  const fired: number[] = [];
  const state = r.schedule("t1", (a) => fired.push(a));
  assert(state?.nextAttempt === 1, "first attempt is 1");
  assert(state?.nextDelayMs === 100, "first delay = base");
  assert(r.isScheduled("t1"), "scheduled");
  t.fire(t.lastHandle());
  assert(fired.length === 1 && fired[0] === 1, "onAttempt fired with attempt 1");
  assert(!r.isScheduled("t1"), "no longer scheduled after fire");
  assert(r.attemptsFor("t1") === 1, "attempt counter incremented");
});

await runCase("schedule: escalating attempts then give-up at maxAttempts", () => {
  const t = fakeTimers();
  const r = new AutoReconnect({ baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0, maxAttempts: 3, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn });
  let gaveUp = -1;
  const fire = () => t.fire(t.lastHandle());
  const scheduleNext = () => r.schedule("t2", () => scheduleNext(), (a) => { gaveUp = a; });
  scheduleNext(); // attempt 1
  fire();         // fires 1 → schedules 2
  fire();         // fires 2 → schedules 3
  fire();         // fires 3 → schedules 4 → exceeds maxAttempts(3) → giveUp
  assert(gaveUp === 3, `gave up after 3 attempts, got ${gaveUp}`);
});

await runCase("cancel stops a pending schedule without resetting attempts", () => {
  const t = fakeTimers();
  const r = new AutoReconnect({ baseDelayMs: 100, jitterRatio: 0, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn });
  r.schedule("t3", () => {});
  assert(r.isScheduled("t3"), "scheduled");
  assert(r.cancel("t3") === true, "cancel returns true");
  assert(!r.isScheduled("t3"), "no longer scheduled");
  assert(t.pendingCount() === 0, "timer cleared");
});

await runCase("clear cancels + resets attempts (manual kill / successful reconnect)", () => {
  const t = fakeTimers();
  const r = new AutoReconnect({ baseDelayMs: 100, jitterRatio: 0, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn });
  r.schedule("t4", () => {});
  t.fire(t.lastHandle());
  r.schedule("t4", () => {});
  assert(r.attemptsFor("t4") === 1, "one attempt fired");
  r.clear("t4");
  assert(r.attemptsFor("t4") === 0, "attempts reset");
  assert(!r.isScheduled("t4"), "not scheduled");
  const s = r.schedule("t4", () => {});
  assert(s?.nextAttempt === 1, "fresh schedule restarts at attempt 1");
});

await runCase("clearAll cancels every pending schedule", () => {
  const t = fakeTimers();
  const r = new AutoReconnect({ baseDelayMs: 100, jitterRatio: 0, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn });
  r.schedule("a", () => {});
  r.schedule("b", () => {});
  r.schedule("c", () => {});
  assert(t.pendingCount() === 3, "3 pending");
  r.clearAll();
  assert(t.pendingCount() === 0, "all cleared");
});

console.log("autoReconnect: all cases passed");
