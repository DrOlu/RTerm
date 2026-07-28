// Integration: TerminalService auto-reconnects a dropped SSH tab (mock backend).
import { TerminalService } from "../TerminalService";

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`);
};
const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

// A mock SSH backend whose exit we can trigger on demand.
function makeMockSshBackend() {
  const exits = new Map<string, (code: number) => void>();
  const datas = new Map<string, (d: string) => void>();
  let spawnCount = 0;
  return {
    spawnCountOf: () => spawnCount,
    backend: {
      spawn: async (_cfg: unknown) => {
        spawnCount += 1;
        return `pty-${spawnCount}`;
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (ptyId: string, cb: (d: string) => void) => { datas.set(ptyId, cb); },
      onExit: (ptyId: string, cb: (code: number) => void) => { exits.set(ptyId, cb); },
      getCwd: () => undefined,
      getHomeDir: async () => undefined,
      getRemoteOs: () => "unix" as const,
      getSystemInfo: async () => undefined,
      getInitializationState: () => "ready" as const,
      triggerExit: (ptyId: string, code = 0) => exits.get(ptyId)?.(code),
    },
  };
}

await runCase("TerminalService schedules auto-reconnect on unexpected SSH exit", async () => {
  const mock = makeMockSshBackend();
  const svc = new TerminalService({} as never);
  // Inject the mock ssh backend.
  (svc as unknown as { backends: Map<string, unknown> }).backends.set("ssh", mock.backend);

  const tab = await svc.createTerminal({
    type: "ssh",
    id: "ssh-t1",
    host: "example",
    username: "u",
    password: "p",
    cols: 80,
    rows: 24,
    title: "ssh-t1",
  } as never);
  assert(tab.type === "ssh", "ssh tab created");
  assert(mock.spawnCountOf() === 1, "spawned once");

  // Simulate an unexpected drop (not a user kill).
  mock.backend.triggerExit("pty-1", 0);
  // reconnectState should be set (a reconnect is scheduled).
  const t1 = (svc as unknown as { terminals: Map<string, { reconnectState?: { scheduled?: boolean; attempt?: number } }> }).terminals.get(tab.id);
  assert(t1?.reconnectState?.scheduled === true, "reconnect scheduled after drop");
  console.log(`  → reconnectState: attempt ${t1?.reconnectState?.attempt}`);

  svc.kill(tab.id);
});

await runCase("manual kill cancels the auto-reconnect schedule", async () => {
  const mock = makeMockSshBackend();
  const svc = new TerminalService({} as never);
  (svc as unknown as { backends: Map<string, unknown> }).backends.set("ssh", mock.backend);
  const tab = await svc.createTerminal({
    type: "ssh", id: "ssh-t2", host: "example", username: "u", password: "p", cols: 80, rows: 24, title: "ssh-t2",
  } as never);
  mock.backend.triggerExit("pty-1", 0);
  const before = (svc as unknown as { terminals: Map<string, { reconnectState?: unknown }> }).terminals.get(tab.id);
  assert(before?.reconnectState !== undefined, "reconnect scheduled");
  // Manual kill must clear the schedule.
  svc.kill(tab.id);
  const autoRec = (svc as unknown as { autoReconnect: { isScheduled: (id: string) => boolean } }).autoReconnect;
  assert(!autoRec.isScheduled(tab.id), "schedule cleared on manual kill");
});

console.log("autoReconnect integration: all cases passed");
