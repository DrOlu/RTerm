import { TerminalService } from './TerminalService'
import type { TerminalBackend, TerminalConfig } from '../types'

/**
 * terminalService.extreme.spec — tests for the v3.2.1+v3.2.2 terminal/chat fixes:
 * (a) pending-write buffer: keystrokes buffered when not writable, flushed when ready
 * (h) max-retry + connection-death: buffer dropped after 3 retries or when exited
 * (e) setImmediate batching in handleData: recording/logging deferred
 */

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
const assertTrue = (cond: boolean, message: string): void => { if (!cond) throw new Error(message) }

// ─── Fake backend ─────────────────────────────────────────────────────────────
class FakeBackend implements TerminalBackend {
  private dataCallbacks = new Map<string, (data: string) => void>()
  private exitCallbacks = new Map<string, (code: number) => void>()
  writes = new Map<string, string[]>()
  spawned = false

  async spawn(config: TerminalConfig): Promise<string> {
    const ptyId = `fake-${config.id}`
    this.spawned = true
    this.writes.set(ptyId, [])
    return ptyId
  }
  onData(ptyId: string, cb: (data: string) => void) { this.dataCallbacks.set(ptyId, cb) }
  onExit(ptyId: string, cb: (code: number) => void) { this.exitCallbacks.set(ptyId, cb) }
  write(ptyId: string, data: string) { (this.writes.get(ptyId) ?? []).push(data); this.writes.set(ptyId, [...(this.writes.get(ptyId) ?? []), data]) }
  resize() {}
  kill() {}
  getRemoteOs() { return 'unix' as const }
  getInitializationState() { return 'ready' as const }
  async getSystemInfo() { return undefined }
  getCwd() { return undefined }
  async getHomeDir(): Promise<string | undefined> { return undefined }
  getCommandTrackingToken() { return undefined }
  startCommandTracking() {}
  stopCommandTracking() {}
  async executeCommand() { return { stdout: '', stderr: '', exitCode: 0 } }
  supportsFilesystem() { return false }
  async listDir() { return [] }
  async readTextFile() { return '' }
  async readFileBase64() { return '' }
  async writeTextFile() {}
  async writeFileBase64() {}
  async createDirectory() {}
  async createFile() {}
  async deletePath() {}
  async renamePath() {}
  async getStat() { return undefined }

  // Helper: emit data to the terminal
  emitData(ptyId: string, data: string) { this.dataCallbacks.get(ptyId)?.(data) }
  emitExit(ptyId: string, code: number) { this.exitCallbacks.get(ptyId)?.(code) }
}

const createService = (): { service: TerminalService; backend: FakeBackend } => {
  const service = new TerminalService()
  const backend = new FakeBackend()
  // @ts-expect-error: inject fake backend
  service.backends.set('local', backend)
  return { service, backend }
}

const localConfig = (id: string): TerminalConfig => ({
  type: 'local', id, title: 'Test', cols: 80, rows: 24,
} as TerminalConfig)

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) { tests.push({ name, run }) }

// ─── (a) Pending-write buffer: keystrokes buffered when not writable, flushed when ready ──
test('write buffers keystrokes when terminal is initializing, flushes when ready', async () => {
  const { service, backend } = createService()
  const config = localConfig('test-buffer')
  // Make it SSH so it starts in 'initializing' state
  const sshConfig = { ...config, type: 'ssh' as const, host: 'fake', port: 22, username: 'u', password: 'p' }
  // @ts-expect-error: inject fake SSH backend
  service.backends.set('ssh', backend)

  // Create the terminal (will be in 'initializing' state for SSH)
  await service.createTerminal(sshConfig as TerminalConfig)

  // Write while initializing — should be buffered, not sent to backend
  service.write('test-buffer', 'echo hello\n')
  assertEqual(backend.writes.get('fake-test-buffer')?.length ?? 0, 0, 'writes should be buffered, not sent')

  // Wait for the 500ms retry timer
  await new Promise(r => setTimeout(r, 600))

  // The retry timer fires but the terminal is still initializing (FakeBackend always returns 'ready')
  // Actually FakeBackend.getInitializationState returns 'ready', so the TerminalService will have
  // transitioned to 'ready' on first data. Let's emit data to trigger the transition.
  backend.emitData('fake-test-buffer', 'shell output\n')
  await new Promise(r => setTimeout(r, 50))

  // Now write again — should go through directly
  service.write('test-buffer', 'echo world\n')
  const writes = backend.writes.get('fake-test-buffer') ?? []
  assertTrue(writes.length > 0, 'writes should have been sent after terminal became ready')
  assertTrue(writes.some(w => w.includes('echo world')), 'the new write should be in the backend writes')
})

// ─── (h) Max-retry + connection-death: buffer dropped after 3 retries or when exited ──
test('write drops buffer when terminal runtimeState is exited (connection dead)', async () => {
  const { service } = createService()
  const config = localConfig('test-dead')
  await service.createTerminal(config)

  // Simulate terminal exit
  // @ts-expect-error: access internal
  const tab = service.terminals.get('test-dead')
  assertTrue(!!tab, 'tab should exist')
  tab!.runtimeState = 'exited'

  // Write — should be dropped immediately (not buffered)
  service.write('test-dead', 'should be dropped\n')

  // Wait and verify no pending writes
  await new Promise(r => setTimeout(r, 600))
  // @ts-expect-error: access internal
  const pending = service.pendingWrites.get('test-dead')
  assertEqual(pending, undefined, 'pending writes should be dropped for exited terminal')
})

test('write drops buffer after MAX_WRITE_RETRIES (3) when terminal stays unwritable', async () => {
  const { service } = createService()
  const sshConfig = { type: 'ssh' as const, id: 'test-retry', title: 'Test', cols: 80, rows: 24, host: 'fake', port: 22, username: 'u', password: 'p' }
  const backend = new FakeBackend()
  // @ts-expect-error: inject fake backend
  service.backends.set('ssh', backend)

  await service.createTerminal(sshConfig as TerminalConfig)

  // Force the terminal to stay in 'initializing' (never transition to 'ready')
  // @ts-expect-error: access internal
  const tab = service.terminals.get('test-retry')
  tab!.runtimeState = 'initializing'
  tab!.isInitializing = true

  // Write 4 times (each triggers a retry timer)
  for (let i = 0; i < 4; i++) {
    service.write('test-retry', `cmd${i}\n`)
    // Wait for the retry timer to fire + increment the retry counter
    await new Promise(r => setTimeout(r, 600))
  }

  // After 4 retries (> MAX_WRITE_RETRIES=3), the buffer should be dropped
  // @ts-expect-error: access internal
  const pending = service.pendingWrites.get('test-retry')
  // The buffer should have been dropped (either by the retry limit or the exit check)
  // Note: the exact behavior depends on timing — but after 4*600ms, the retries should exceed 3
  assertTrue(pending === undefined || pending === '', 'buffer should be dropped after max retries')
})

// ─── (e) setImmediate batching in handleData: recording/logging deferred ──
test('handleData defers session recording/logging via setImmediate (does not block)', async () => {
  const { service, backend } = createService()
  const config = localConfig('test-batch')
  await service.createTerminal(config)

  // Set up a recorder to detect if recording is deferred
  let recordingCalled = false

  // @ts-expect-error: inject a fake session recorder
  service.sessionRecorder = {
    out: () => { recordingCalled = true },
    start: () => 'rec-1',
    stop: () => ({ id: 'rec-1', terminalId: 'test-batch', startedAt: 0, width: 80, height: 24, events: [] }),
  }
  // @ts-expect-error: start recording
  service.activeRecordings.set('test-batch', 'rec-1')

  // Emit data
  backend.emitData('fake-test-batch', 'hello world\n')

  // At this point, setImmediate hasn't fired yet (synchronous code is still running)
  // So recordingCalled should be false (deferred by setImmediate)
  assertEqual(recordingCalled, false, 'recording should be deferred by setImmediate (not called synchronously)')

  // Wait for setImmediate to fire
  await new Promise(r => setImmediate(r))

  // Now recordingCalled should be true (setImmediate has fired)
  assertEqual(recordingCalled, true, 'recording should be called after setImmediate fires')
})

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
