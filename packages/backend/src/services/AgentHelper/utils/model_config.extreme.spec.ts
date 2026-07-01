import { buildToolsForModel } from '../tools'
import { buildBuiltInToolStatusSummary } from '../../Gateway/toolingSummary'
import { computeReadFileSupport, getEnabledBuiltInTools } from './model_config'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertIncludes = <T>(values: T[], expected: T, message: string): void => {
  if (!values.includes(expected)) {
    throw new Error(`${message}. expected=${String(expected)} actual=${JSON.stringify(values)}`)
  }
}

const assertNotIncludes = <T>(values: T[], expected: T, message: string): void => {
  if (values.includes(expected)) {
    throw new Error(`${message}. unexpected=${String(expected)} actual=${JSON.stringify(values)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const toolName = (tool: any): string => tool?.function?.name ?? tool?.name ?? ''

const run = async (): Promise<void> => {
  await runCase('configured text-only model disables image visibility for the whole profile', () => {
    const support = computeReadFileSupport(
      { imageInputs: true },
      { imageInputs: true },
      { imageInputs: false }
    )
    assertEqual(
      support.image,
      false,
      'profile image visibility should be disabled when any configured model lacks image support'
    )
  })

  await runCase('unset optional models do not disable profile image visibility', () => {
    const support = computeReadFileSupport(
      { imageInputs: true },
      undefined,
      undefined
    )
    assertEqual(
      support.image,
      true,
      'missing optional models should not disable image visibility'
    )
  })

  await runCase('file mutation capability exposes split model tools only', () => {
    const names = buildToolsForModel({ image: false }).map(toolName)
    assertIncludes(names, 'write_file', 'write_file should be model-visible')
    assertIncludes(names, 'edit_file', 'edit_file should be model-visible')
    assertNotIncludes(names, 'create_or_edit', 'create_or_edit should stay capability-only for model tools')
  })

  await runCase('create_or_edit capability disables split file model tools', () => {
    const enabled = getEnabledBuiltInTools(buildToolsForModel({ image: false }), {
      create_or_edit: false
    }).map(toolName)
    assertNotIncludes(enabled, 'write_file', 'write_file should be disabled by create_or_edit=false')
    assertNotIncludes(enabled, 'edit_file', 'edit_file should be disabled by create_or_edit=false')
    assertIncludes(enabled, 'exec_command', 'unrelated built-in tools should remain enabled')
  })

  await runCase('built-in status summary keeps one file mutation capability', () => {
    const names = buildBuiltInToolStatusSummary({ create_or_edit: true }).map((tool) => tool.name)
    assertIncludes(names, 'create_or_edit', 'create_or_edit should stay user-visible as the capability')
    assertNotIncludes(names, 'write_file', 'write_file should not become a settings row')
    assertNotIncludes(names, 'edit_file', 'edit_file should not become a settings row')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
