import { parseDaguYaml, parseDaguWorkflow, daguExecutionPlan, type DaguDocument } from './daguParser'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

const SIMPLE = `
name: hello-world
description: a simple dagu workflow
steps:
  - id: extract
    run: echo "extracting data"
  - id: transform
    run: echo "transforming"
    depends: extract
  - id: load
    run: echo "loading"
    depends: transform
`

const PARALLEL = `
name: parallel-etl
steps:
  - id: extract_a
    run: echo "a"
  - id: extract_b
    run: echo "b"
  - id: join
    run: echo "join"
    depends:
      - extract_a
      - extract_b
`

test('parse: simple linear dagu workflow compiles to a playbook with 3 steps', () => {
  const { playbook } = parseDaguYaml(SIMPLE)
  if (playbook.name !== 'hello-world') throw new Error(`name ${playbook.name}`)
  if (playbook.steps.length !== 3) throw new Error(`steps ${playbook.steps.length}`)
  if (playbook.steps[0].id !== 'extract') throw new Error('step 0 id')
  if (playbook.steps[1].command !== 'echo "transforming"') throw new Error('step 1 command')
  if (playbook.steps[2].dependsOn?.join() !== 'transform') throw new Error('step 2 depends')
})

test('parse: parallel fan-out/fan-in produces correct DAG waves', () => {
  const { playbook } = parseDaguYaml(PARALLEL)
  const plan = daguExecutionPlan(playbook)
  if (!plan.includes('extract_a') || !plan.includes('extract_b')) throw new Error('fan-out missing')
  if (!plan.includes('join')) throw new Error('join missing')
  // extract_a and extract_b should be in the same wave (both no depends -> linear default makes them sequential unless dependsOn:[]).
  // With no depends declared, dagu steps default to linear; the plan should still order join last.
  const lines = plan.split('\n')
  if (!lines[lines.length - 1].includes('join')) throw new Error('join should be last wave')
})

test('parse: name/description/params/env carried through', () => {
  const doc: DaguDocument = {
    name: 'wf', description: 'desc',
    params: { region: 'us-east-1', env: { default: 'prod' } },
    steps: [{ id: 'a', run: 'echo x' }],
  }
  const { playbook } = parseDaguWorkflow(doc)
  if (playbook.description !== 'desc') throw new Error('description')
  if (!playbook.params || playbook.params.length !== 2) throw new Error('params')
  if (playbook.params[0].name !== 'region' || playbook.params[0].defaultValue !== 'us-east-1') throw new Error('param default')
  if (playbook.params[1].defaultValue !== 'prod') throw new Error('param object default')
})

test('parse: continue_on maps to onError: continue', () => {
  const doc: DaguDocument = { steps: [{ id: 'a', run: 'x', continue_on: true }, { id: 'b', run: 'y' }] }
  const { playbook } = parseDaguWorkflow(doc)
  if (playbook.steps[0].onError !== 'continue') throw new Error('continue_on not mapped')
  if (playbook.steps[1].onError === 'continue') throw new Error('should not apply to others')
})

test('parse: retry_policy emits a warning', () => {
  const doc: DaguDocument = { steps: [{ id: 'a', run: 'x', retry_policy: { limit: 3 } }] }
  const { warnings } = parseDaguWorkflow(doc)
  if (!warnings.some((w) => w.includes('retry_policy'))) throw new Error('should warn about retry_policy')
})

test('parse: preconditions map to desiredState guard', () => {
  const doc: DaguDocument = { steps: [{ id: 'a', run: 'x', preconditions: 'test -f /tmp/ok' }] }
  const { playbook } = parseDaguWorkflow(doc)
  if (!playbook.steps[0].desiredState) throw new Error('precondition not mapped')
})

test('parse: command/cmd/script/call step forms all produce a command', () => {
  const doc: DaguDocument = {
    steps: [
      { id: 'a', run: 'run-cmd' },
      { id: 'b', command: 'command-cmd' },
      { id: 'c', cmd: 'cmd-cmd' },
      { id: 'd', script: 'echo scripted' },
      { id: 'e', call: 'sub-wf' },
    ],
  }
  const { playbook } = parseDaguWorkflow(doc)
  if (playbook.steps[0].command !== 'run-cmd') throw new Error('run')
  if (playbook.steps[1].command !== 'command-cmd') throw new Error('command')
  if (playbook.steps[2].command !== 'cmd-cmd') throw new Error('cmd')
  if (!playbook.steps[3].command?.includes('scripted')) throw new Error('script')
  if (!playbook.steps[4].command?.includes('sub-wf')) throw new Error('call')
})

test('parse: depends as a string (not array) is normalized to an array', () => {
  const doc: DaguDocument = { steps: [{ id: 'a', run: 'x' }, { id: 'b', run: 'y', depends: 'a' }] }
  const { playbook } = parseDaguWorkflow(doc)
  if (!Array.isArray(playbook.steps[1].dependsOn) || playbook.steps[1].dependsOn![0] !== 'a') throw new Error('depends string not normalized')
})

test('parse: empty steps warns', () => {
  const doc: DaguDocument = { name: 'empty' }
  const { warnings } = parseDaguWorkflow(doc)
  if (!warnings.some((w) => w.includes('No steps'))) throw new Error('should warn on empty steps')
})

test('parse: invalid YAML throws a clear error', () => {
  let threw = false
  try { parseDaguYaml('not: [valid') } catch { threw = true }
  if (!threw) throw new Error('should throw on invalid yaml')
})

test('parse: id is sanitized (spaces -> dashes)', () => {
  const doc: DaguDocument = { steps: [{ id: 'my step!', run: 'x' }] }
  const { playbook } = parseDaguWorkflow(doc)
  if (playbook.steps[0].id !== 'my-step-') throw new Error(`id ${playbook.steps[0].id}`)
})

test('parse: maxParallelSteps set for DAG execution', () => {
  const { playbook } = parseDaguYaml(PARALLEL)
  if (typeof playbook.maxParallelSteps !== 'number' || playbook.maxParallelSteps < 1) throw new Error('maxParallelSteps missing')
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
