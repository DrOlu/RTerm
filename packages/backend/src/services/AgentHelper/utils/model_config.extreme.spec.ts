import { computeReadFileSupport } from './model_config'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

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
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
