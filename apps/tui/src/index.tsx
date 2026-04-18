import { startTuiCli } from '../../../packages/tui/src/index'

void startTuiCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`RTerm TUI failed: ${message}\n`)
  process.exitCode = 1
})
