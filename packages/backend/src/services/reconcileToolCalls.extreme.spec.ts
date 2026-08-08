/**
 * reconcileToolCalls.extreme.spec — tests for v3.2.5 Feature 2:
 * Streamed multi-tool reconciliation (validate IDs, indices, args before dispatch)
 */
export {}


const tests: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}

// ─── Copy of reconcileToolCalls logic ────────────────────────────────────────
function reconcileToolCalls(toolCalls: any[]): any[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return []
  const seen = new Set<string>()
  const result: any[] = []
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue
    if (!tc.name || typeof tc.name !== 'string') continue
    let args = tc.args
    if (args == null) { args = {} }
    else if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
    const id = tc.id || ''
    if (id) { if (seen.has(id)) continue; seen.add(id) }
    const dedupKey = `${tc.name}::${JSON.stringify(args)}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    result.push({ ...tc, args })
  }
  return result
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('empty array returns empty', () => {
  assertEqual(reconcileToolCalls([]).length, 0, 'empty input should return empty')
})

test('null/non-array returns empty', () => {
  assertEqual(reconcileToolCalls(null as any).length, 0, 'null should return empty')
  assertEqual(reconcileToolCalls(undefined as any).length, 0, 'undefined should return empty')
})

test('valid single tool call passes through', () => {
  const input = [{ id: 'tc1', name: 'exec_command', args: { command: 'ls' } }]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'single valid call should pass through')
  assertEqual(result[0].name, 'exec_command', 'name preserved')
  assertEqual(result[0].args.command, 'ls', 'args preserved')
})

test('duplicate IDs are dropped (keep first)', () => {
  const input = [
    { id: 'tc1', name: 'read_file', args: { filePath: '/a' } },
    { id: 'tc1', name: 'read_file', args: { filePath: '/b' } },
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'duplicate ID should be dropped')
  assertEqual(result[0].args.filePath, '/a', 'first occurrence kept')
})

test('missing name is dropped', () => {
  const input = [
    { id: 'tc1', name: '', args: {} },
    { id: 'tc2', name: 'read_file', args: { filePath: '/a' } },
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'call without name should be dropped')
  assertEqual(result[0].name, 'read_file', 'valid call kept')
})

test('null args default to empty object', () => {
  const input = [{ id: 'tc1', name: 'get_metrics', args: null }]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'call with null args should be kept')
  assertEqual(JSON.stringify(result[0].args), '{}', 'null args should become {}')
})

test('undefined args default to empty object', () => {
  const input = [{ id: 'tc1', name: 'get_metrics', args: undefined }]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'call with undefined args should be kept')
  assertEqual(JSON.stringify(result[0].args), '{}', 'undefined args should become {}')
})

test('string args that are valid JSON are parsed', () => {
  const input = [{ id: 'tc1', name: 'exec_command', args: '{"command":"ls -la"}' }]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'valid JSON string args should be kept')
  assertEqual(result[0].args.command, 'ls -la', 'string args should be parsed')
})

test('string args that are invalid JSON default to empty object', () => {
  const input = [{ id: 'tc1', name: 'exec_command', args: 'not json{' }]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'invalid JSON args should be kept')
  assertEqual(JSON.stringify(result[0].args), '{}', 'invalid JSON should become {}')
})

test('duplicate (name + args) pairs are dropped', () => {
  const input = [
    { id: 'tc1', name: 'read_file', args: { filePath: '/a' } },
    { id: 'tc2', name: 'read_file', args: { filePath: '/a' } },
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'duplicate name+args should be dropped')
})

test('same name with different args are kept', () => {
  const input = [
    { id: 'tc1', name: 'read_file', args: { filePath: '/a' } },
    { id: 'tc2', name: 'read_file', args: { filePath: '/b' } },
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 2, 'same name different args should be kept')
})

test('non-object entries are dropped', () => {
  const input = [
    null,
    'not an object',
    42,
    { id: 'tc1', name: 'read_file', args: { filePath: '/a' } },
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 1, 'non-object entries should be dropped')
  assertEqual(result[0].name, 'read_file', 'valid entry kept')
})

test('mixed valid and invalid entries are filtered correctly', () => {
  const input = [
    { id: 'tc1', name: 'read_file', args: { filePath: '/a' } },
    { id: 'tc1', name: 'read_file', args: { filePath: '/b' } }, // dup ID
    { name: '', args: {} }, // no name
    { id: 'tc2', name: 'get_metrics', args: null }, // null args -> {}
    { id: 'tc3', name: 'get_metrics', args: null }, // dup (name+args)
    { id: 'tc4', name: 'exec_command', args: '{"command":"pwd"}' }, // valid JSON string
  ]
  const result = reconcileToolCalls(input)
  assertEqual(result.length, 3, 'should keep 3 valid unique calls')
  assertEqual(result[0].name, 'read_file', 'first is read_file')
  assertEqual(result[1].name, 'get_metrics', 'second is get_metrics')
  assertEqual(result[2].name, 'exec_command', 'third is exec_command')
  assertEqual(result[2].args.command, 'pwd', 'exec_command args parsed')
})

// ─── Runner ─────────────────────────────────────────────────────────────────
function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
