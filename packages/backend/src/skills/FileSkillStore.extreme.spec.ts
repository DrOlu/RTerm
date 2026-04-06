import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileSkillStore } from './FileSkillStore'

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gyshell-skill-store-'))
  try {
    await fn(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const exists = async (targetPath: string): Promise<boolean> =>
  fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false)

const run = async (): Promise<void> => {
  await runCase('reload creates only the primary skill directory and skips missing compatibility roots', async () => {
    await withTempDir(async (tempDir) => {
      const primaryRoot = path.join(tempDir, 'gyshell-data', 'skills')
      const missingClaudeRoot = path.join(tempDir, 'home', '.claude', 'skills')
      const missingAgentsRoot = path.join(tempDir, 'home', '.agents', 'skills')
      const missingCodexRoot = path.join(tempDir, 'home', '.codex', 'skills')
      const missingCodexHomeRoot = path.join(tempDir, 'codex-home', 'skills')

      const store = new FileSkillStore({
        getPrimaryRoot: () => primaryRoot,
        getScanRoots: () => [
          primaryRoot,
          missingClaudeRoot,
          missingAgentsRoot,
          missingCodexRoot,
          missingCodexHomeRoot
        ]
      })

      const skills = await store.reload()

      assertEqual(skills.length, 0, 'reload should not synthesize skills for empty roots')
      assert(await exists(primaryRoot), 'reload should create the primary skills root')
      assert(!(await exists(missingClaudeRoot)), 'reload must not create missing Claude compatibility roots')
      assert(!(await exists(missingAgentsRoot)), 'reload must not create missing agents compatibility roots')
      assert(!(await exists(missingCodexRoot)), 'reload must not create missing Codex compatibility roots')
      assert(!(await exists(missingCodexHomeRoot)), 'reload must not create missing CODEX_HOME compatibility roots')
    })
  })

  await runCase('createSkillFromTemplate still creates the primary skill directory', async () => {
    await withTempDir(async (tempDir) => {
      const primaryRoot = path.join(tempDir, 'gyshell-data', 'skills')
      const store = new FileSkillStore({
        getPrimaryRoot: () => primaryRoot,
        getScanRoots: () => [primaryRoot]
      })

      const created = await store.createSkillFromTemplate()

      assert(await exists(primaryRoot), 'createSkillFromTemplate should create the primary skills root')
      assertEqual(created.filePath, path.join(primaryRoot, created.fileName), 'created skill should live in the primary root')
      assertEqual(created.baseDir, primaryRoot, 'created skill metadata should point to the primary root')
    })
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
