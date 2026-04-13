import assert from 'node:assert/strict'
import { waitSchema } from './wait_tools'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

async function run(): Promise<void> {
  // Schema description reflects the new 5-120 range
  {
    const shape = waitSchema.shape.seconds
    const description = (shape as { description?: string }).description ?? ''
    assertEqual(description, 'Number of seconds to wait (5-120)', 'schema description should reflect 5-120 range')
  }

  // Below minimum (4) is rejected
  {
    const result = waitSchema.safeParse({ seconds: 4 })
    assertEqual(result.success, false, 'seconds=4 should be rejected (below min 5)')
  }

  // Minimum boundary (5) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 5 })
    assertEqual(result.success, true, 'seconds=5 should be accepted (min boundary)')
    if (result.success) {
      assertEqual(result.data.seconds, 5, 'seconds=5 should parse to 5')
    }
  }

  // Middle value (60) is accepted under new range
  {
    const result = waitSchema.safeParse({ seconds: 60 })
    assertEqual(result.success, true, 'seconds=60 should be accepted (well within 5-120)')
    if (result.success) {
      assertEqual(result.data.seconds, 60, 'seconds=60 should parse to 60')
    }
  }

  // Middle value (90) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 90 })
    assertEqual(result.success, true, 'seconds=90 should be accepted')
    if (result.success) {
      assertEqual(result.data.seconds, 90, 'seconds=90 should parse to 90')
    }
  }

  // Maximum boundary (120) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 120 })
    assertEqual(result.success, true, 'seconds=120 should be accepted (max boundary)')
    if (result.success) {
      assertEqual(result.data.seconds, 120, 'seconds=120 should parse to 120')
    }
  }

  // Above maximum (121) is rejected
  {
    const result = waitSchema.safeParse({ seconds: 121 })
    assertEqual(result.success, false, 'seconds=121 should be rejected (above max 120)')
  }

  // Far above maximum is rejected
  {
    const result = waitSchema.safeParse({ seconds: 9999 })
    assertEqual(result.success, false, 'seconds=9999 should be rejected (far above max 120)')
  }

  // Non-number is rejected
  {
    const result = waitSchema.safeParse({ seconds: 'sixty' })
    assertEqual(result.success, false, 'non-number seconds should be rejected')
  }

  // Missing seconds is rejected
  {
    const result = waitSchema.safeParse({})
    assertEqual(result.success, false, 'missing seconds field should be rejected')
  }

  console.log('PASS wait_tools.extreme.spec: all 9 cases passed')
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
