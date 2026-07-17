import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TerminalService } from './TerminalService'
import { SessionLogService } from './automation/sessionLogService'

/**
 * sessionLogging.integration.spec — verifies the SessionLogService is hooked
 * into TerminalService.handleData so terminal output is recorded per session,
 * and that the session is flushed to the index on kill.
 */
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(`ASSERT: ${msg}`) }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-sesslog-'))
  const logger = new SessionLogService({ logDir: dir })
  const svc = new TerminalService()
  svc.setSessionLogger(logger)

  const tab = await svc.createTerminal({
    type: 'local', id: `local-${Date.now()}`, title: 'log-test', cols: 80, rows: 24,
  } as any)

  await new Promise((r) => setTimeout(r, 200))
  svc.write(tab.id, "echo __LOGMARKER__\n")
  await new Promise((r) => setTimeout(r, 600))

  // 1. The log file should exist and contain the marker (recording works).
  const logFile = path.join(dir, `${tab.id}.log`)
  assert(fs.existsSync(logFile), `log file should exist at ${logFile}`)
  const content = fs.readFileSync(logFile, 'utf8')
  assert(content.includes('__LOGMARKER__'), `log should contain marker; got:\n${content}`)

  // 2. Kill the session — this synchronously flushes the log to the index.
  svc.kill(tab.id)
  await new Promise((r) => setTimeout(r, 200))

  // 3. The index should now list the session.
  const list = logger.list()
  assert(list.some((l) => l.sessionId === tab.id && l.title === 'log-test'), 'session in index')

  console.log('PASS session logging records terminal output via handleData + flushes index on kill')
  console.log('ALL SESSION LOGGING INTEGRATION TESTS PASSED')
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
