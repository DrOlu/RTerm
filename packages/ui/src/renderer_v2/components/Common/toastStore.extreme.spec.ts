import assert from 'node:assert'
import { toastStore } from './ToastStore'

/**
 * toastStore.extreme.spec — verifies the global toast store lifecycle
 * (push/dismiss/auto-timer) without rendering React.
 */
let pass = 0, fail = 0
function test(n: string, r: () => void) {
  try { r(); pass++; console.log(`PASS ${n}`) }
  catch (e: any) { fail++; console.log(`FAIL ${n}: ${e?.message ?? e}`) }
}

test('push adds an item with an id', () => {
  const before = toastStore.items.length
  const id = toastStore.push({ title: 'Hi', message: 'm' })
  assert.ok(id, 'id returned')
  assert.strictEqual(toastStore.items.length, before + 1)
  assert.ok(toastStore.items.some((t) => t.id === id))
  toastStore.dismiss(id)
})

test('dismiss removes the item', () => {
  const id = toastStore.push({ title: 'x' })
  toastStore.dismiss(id)
  assert.ok(!toastStore.items.some((t) => t.id === id), 'should be gone')
})

test('auto-dismiss fires after duration', async () => {
  const id = toastStore.push({ title: 'auto', duration: 30 })
  await new Promise((r) => setTimeout(r, 90))
  assert.ok(!toastStore.items.some((t) => t.id === id), 'should auto-dismiss')
})

test('duration 0 keeps it sticky', async () => {
  const id = toastStore.push({ title: 'sticky', duration: 0 })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(toastStore.items.some((t) => t.id === id), 'sticky should remain')
  toastStore.dismiss(id)
})

test('carries kind + actionLabel + onAction', () => {
  let called = false
  const id = toastStore.push({ title: 'Deleted', kind: 'danger', actionLabel: 'Undo', onAction: () => { called = true } })
  const t = toastStore.items.find((x) => x.id === id)
  assert.strictEqual(t?.kind, 'danger')
  assert.strictEqual(t?.actionLabel, 'Undo')
  t?.onAction?.()
  assert.ok(called, 'onAction callable')
  toastStore.dismiss(id)
})

test('dismiss of unknown id is a no-op', () => {
  const before = toastStore.items.length
  toastStore.dismiss('does-not-exist')
  assert.strictEqual(toastStore.items.length, before)
})

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
