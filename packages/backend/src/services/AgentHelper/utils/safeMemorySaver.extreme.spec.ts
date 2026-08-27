import {
  CHECKPOINT_MAX_MESSAGES,
  CHECKPOINT_STRING_CAP,
  isAllocationError,
  pruneCheckpointForSaver,
} from './safeMemorySaver'

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(m)
}
const eq = <T>(a: T, b: T, m: string): void => {
  if (a !== b) throw new Error(`${m}: expected=${String(b)} actual=${String(a)}`)
}
const run = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => console.log(`PASS ${name}`))

await run('isAllocationError: RangeError Failed to allocate memory', () => {
  const e = new RangeError('Failed to allocate memory')
  assert(isAllocationError(e), 'range')
})
await run('isAllocationError: invalid string length', () => {
  assert(isAllocationError(new Error('Invalid string length')), 'isl')
})
await run('isAllocationError: ERR_STRING_TOO_LONG', () => {
  assert(isAllocationError(new Error('ERR_STRING_TOO_LONG')), 'too long')
})
await run('isAllocationError: array buffer allocation failed', () => {
  assert(isAllocationError(new Error('Array buffer allocation failed')), 'ab')
})
await run('isAllocationError: ordinary Error is not allocation', () => {
  assert(!isAllocationError(new Error('fallback model missing')), 'ordinary')
})
await run('isAllocationError: null/undefined/empty', () => {
  assert(!isAllocationError(null), 'null')
  assert(!isAllocationError(undefined), 'undef')
  assert(!isAllocationError(''), 'empty')
})

await run('prune: truncates long string fields in messages', () => {
  const huge = 'x'.repeat(CHECKPOINT_STRING_CAP + 5000)
  const pruned = pruneCheckpointForSaver({
    id: 'cp-1',
    channel_values: {
      messages: [{ type: 'tool', content: huge }],
    },
  }) as any
  const content = pruned.channel_values.messages[0].content as string
  assert(content.length < huge.length, 'shorter')
  assert(content.includes('truncated'), 'marker')
  assert(content.length <= CHECKPOINT_STRING_CAP + 80, 'cap roughly held')
})

await run('prune: drops older messages beyond CHECKPOINT_MAX_MESSAGES', () => {
  const messages = Array.from({ length: CHECKPOINT_MAX_MESSAGES + 25 }, (_, i) => ({
    type: 'human',
    content: `msg-${i}`,
  }))
  const pruned = pruneCheckpointForSaver({
    channel_values: { messages },
  }) as any
  const out = pruned.channel_values.messages as any[]
  assert(out.length <= CHECKPOINT_MAX_MESSAGES, `len=${out.length}`)
  assert(String(out[0].content).includes('dropped'), 'drop marker')
  eq(out[out.length - 1].content, `msg-${messages.length - 1}`, 'kept last')
})

await run('prune: nested tool kwargs truncated', () => {
  const pruned = pruneCheckpointForSaver({
    channel_values: {
      other: { kwargs: { content: 'y'.repeat(CHECKPOINT_STRING_CAP + 10) } },
    },
  }) as any
  const c = pruned.channel_values.other.kwargs.content as string
  assert(c.includes('truncated'), 'nested truncated')
})

await run('prune: non-object checkpoint passthrough', () => {
  eq(pruneCheckpointForSaver(null), null, 'null')
  eq(pruneCheckpointForSaver(undefined), undefined, 'undef')
  eq(pruneCheckpointForSaver(12) as any, 12, 'num')
})

await run('prune: pending_sends pruned', () => {
  const pruned = pruneCheckpointForSaver({
    pending_sends: ['z'.repeat(CHECKPOINT_STRING_CAP + 20)],
  }) as any
  assert((pruned.pending_sends[0] as string).includes('truncated'), 'sends')
})

await run('prune: short strings unchanged', () => {
  const pruned = pruneCheckpointForSaver({
    channel_values: { messages: [{ content: 'hello' }] },
  }) as any
  eq(pruned.channel_values.messages[0].content, 'hello', 'short')
})

console.log('All safeMemorySaver extreme tests passed.')
