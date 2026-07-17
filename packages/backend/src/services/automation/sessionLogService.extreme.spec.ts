import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionLogService } from './sessionLogService'

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-log-'))
}

test('start/write/stop persists output + index', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s1', { title: 'web-1', type: 'ssh' })
  svc.write('s1', 'hello\n')
  svc.write('s1', 'world\n')
  svc.stop('s1')
  const content = fs.readFileSync(path.join(dir, 's1.log'), 'utf8')
  if (content !== 'hello\nworld\n') throw new Error(`unexpected content: ${JSON.stringify(content)}`)
  const list = svc.list()
  if (list.length !== 1 || list[0].title !== 'web-1') throw new Error(JSON.stringify(list))
  if (list[0].endedAt === undefined) throw new Error('endedAt should be set after stop')
})

test('read returns full log', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s2', { title: 'r1', type: 'winrm' })
  svc.write('s2', 'line1\nline2\n')
  svc.stop('s2')
  if (svc.read('s2') !== 'line1\nline2\n') throw new Error('read mismatch')
})

test('list is sorted newest-first', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('old', { title: 'old', type: 'ssh' }); svc.stop('old')
  await new Promise((r) => setTimeout(r, 20))
  svc.start('new', { title: 'new', type: 'ssh' }); svc.stop('new')
  const list = svc.list()
  if (list[0].title !== 'new') throw new Error('newest should be first')
})

test('resume appends to existing log preserving start time', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s3', { title: 'r', type: 'ssh' })
  svc.write('s3', 'first\n')
  svc.stop('s3')
  const firstStart = svc.list()[0].startedAt
  await new Promise((r) => setTimeout(r, 20))
  svc.start('s3', { title: 'r', type: 'ssh' })
  svc.write('s3', 'second\n')
  svc.stop('s3')
  if (svc.read('s3') !== 'first\nsecond\n') throw new Error('should append')
  if (svc.list()[0].startedAt !== firstStart) throw new Error('start time should be preserved')
})

test('delete removes log + index entry', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s4', { title: 'r', type: 'ssh' }); svc.write('s4', 'x\n'); svc.stop('s4')
  svc.delete('s4')
  if (svc.list().length !== 0) throw new Error('list should be empty')
  if (fs.existsSync(path.join(dir, 's4.log'))) throw new Error('log file should be gone')
})

test('write before start is a no-op (no throw)', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.write('ghost', 'data')
  // no throw, no file
  if (fs.existsSync(path.join(dir, 'ghost.log'))) throw new Error('should not create file')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
