/**
 * neuralos — plugin extreme spec.
 *
 * Pure invariants, always run, no network and no engine required:
 * config precedence, engine-name mapping, JSON recovery, instance
 * discovery, engine selection against a FAKE engine script (node is the
 * only dependency), probe execution against a FAKE python (the runner is
 * exercised via an injected exec), the graph direct-execution rule, and
 * the admin confirm interlock. The auto-download path is tested with an
 * injected fetch that writes local files — CI never touches HuggingFace.
 *
 * Run:  npx tsx plugins/neuralos/neuralos.extreme.spec.mts
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HF_BASE,
  adminProbe,
  bundledEngineName,
  defaultExec,
  engineSelect,
  ensureEngine,
  executeProbe,
  graphProbe,
  listInstances,
  parseJsonObject,
  resolveConfig,
  resolveEngine,
  truncate,
} from './neuralosEngine.mjs'
import { register } from './index.mjs'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: unknown, label: string, note = ''): void {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    failures.push(`${label}${note ? ` — ${note}` : ''}`)
    console.log(`FAIL ${label}${note ? ` — ${note}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Config precedence: settings block > env > default; blank = unset.
// ---------------------------------------------------------------------------
{
  const cfg = resolveConfig({ getSettings: () => ({ neuralos: { pythonBin: '/framework/python3.12', instancesDir: '  ' } }) }, {})
  ok(cfg.pythonBin === '/framework/python3.12', 'settings block wins for pythonBin')
  ok(cfg.instancesDir === join(homedir(), 'neuralos-instances'), 'blank settings value falls through to default', cfg.instancesDir)

  const cfgEnv = resolveConfig({ getSettings: () => ({}) }, { NEURALOS_INSTANCES_DIR: '/custom/instances' })
  ok(cfgEnv.instancesDir === '/custom/instances', 'env wins when settings are silent')

  const cfgOff = resolveConfig({ getSettings: () => ({ neuralos: { autoDownload: false } }) }, {})
  ok(cfgOff.autoDownload === false, 'autoDownload can be disabled in settings')
  const cfgOn = resolveConfig({ getSettings: () => ({}) }, {})
  ok(cfgOn.autoDownload === true, 'autoDownload defaults on')
}
// ---------------------------------------------------------------------------
// 2. Engine name mapping (macos-x64 has no published engine).
// ---------------------------------------------------------------------------
{
  ok(bundledEngineName('darwin', 'arm64') === 'engine-macos-arm64', 'darwin/arm64 maps to engine-macos-arm64')
  ok(bundledEngineName('linux', 'x64') === 'engine-linux-x86_64', 'linux/x64 maps to engine-linux-x86_64')
  ok(bundledEngineName('linux', 'arm64') === 'engine-linux-arm64', 'linux/arm64 maps to engine-linux-arm64')
  ok(bundledEngineName('win32', 'x64') === 'engine-windows-x86_64.exe', 'win32/x64 maps to engine-windows-x86_64.exe')
  ok(bundledEngineName('darwin', 'x64') === null, 'darwin/x64 has no published engine')
}

// ---------------------------------------------------------------------------
// 3. JSON recovery from noisy engine output.
// ---------------------------------------------------------------------------
{
  const parsed = parseJsonObject('noise {"function_calls":[{"name":"p"}], "confidence": 0.9} trailing')
  ok(parsed?.function_calls?.[0]?.name === 'p', 'parseJsonObject recovers JSON embedded in noise')
  ok(parseJsonObject('not json') === null, 'parseJsonObject returns null for garbage')
}

// ---------------------------------------------------------------------------
// 4. Instance discovery (fake instances root in a temp dir).
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'neuralos-spec-'))
  mkdirSync(join(root, 'chinook'))
  writeFileSync(join(root, 'chinook', 'needle_menu.json'), JSON.stringify([{ name: 'p1' }, { name: 'p2' }]))
  mkdirSync(join(root, 'not-an-instance'))

  const cfg = resolveConfig({}, { NEURALOS_INSTANCES_DIR: root })
  const listed = await listInstances(cfg)
  ok(
    Array.isArray(listed) && listed.length === 1 && listed[0].name === 'chinook' && listed[0].probeCount === 2,
    'listInstances finds only dirs with a needle_menu.json',
    JSON.stringify(listed),
  )

  const missing = await listInstances(cfg, { readdir: async () => { throw new Error('ENOENT') }, readFile: async () => '' })
  ok(
    (missing as { error?: string }).error?.includes('no instances directory'),
    'listInstances reports a missing root as data',
  )
}

// ---------------------------------------------------------------------------
// 5. Engine selection against a FAKE engine (a node script).
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'neuralos-engine-'))
  const fakeEngine = join(dir, 'fake-engine.mjs')
  writeFileSync(
    fakeEngine,
    `const args = process.argv.slice(2)
const qi = args.indexOf('--prompt')
const q = qi >= 0 ? args[qi + 1] : ''
if (q === 'refuse me') { console.log(JSON.stringify({ function_calls: [] })) }
else if (q === 'garbage') { console.log('not json at all') }
else if (q === 'crash') { process.stderr.write('boom'); process.exit(1) }
else { console.log(JSON.stringify({ function_calls: [{ name: 'transactions_count', arguments: { limit: 5 } }], confidence: 0.98 })) }
`,
  )
  const runEngine = (q: string) =>
    engineSelect(
      (cmd: string, args: string[]) => {
        void cmd
        const r = spawnSync(process.execPath, [fakeEngine, ...args.slice(2)], { encoding: 'utf8' })
        return Promise.resolve({ ok: r.status === 0, code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' })
      },
      { engineBin: fakeEngine, engineWeights: join(dir, 'weights.cact') },
      '/i/needle_menu.json',
      q,
    )

  const hit = await runEngine('count invoices')
  ok(hit.pick === 'transactions_count' && hit.confidence === 0.98, 'engineSelect parses the selection with confidence', JSON.stringify(hit))
  const refused = await runEngine('refuse me')
  ok((refused as { error?: string }).error === 'engine refused the question (no call selected)', 'refusal is data, not an exception')
  const garbage = await runEngine('garbage')
  ok((garbage as { error?: string }).error?.includes('engine output not JSON'), 'non-JSON engine output is data')
  const crash = await runEngine('crash')
  ok((crash as { error?: string }).error === 'engine exited 1: boom', 'engine crash with empty stdout is data')
}

// ---------------------------------------------------------------------------
// 6. Probe execution via an injected exec (the real path spawns python).
// ---------------------------------------------------------------------------
{
  const cfg = resolveConfig({}, { NEURALOS_PYTHON: '/framework/python3.12' })
  const seen: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = []
  const exec = (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    seen.push({ cmd, args, env: opts.env ?? {} })
    return Promise.resolve({ ok: true, code: 0, stdout: '{"count": 42}', stderr: '' })
  }
  const result = await executeProbe(exec, cfg, '/i', 'transactions_count', { limit: 5 })
  ok(result.count === 42, 'executeProbe returns the parsed digest')
  ok(seen[0].cmd === '/framework/python3.12' && seen[0].args[0] === '-c', 'executeProbe spawns the configured python with the runner')
  ok(
    seen[0].env.NEURALOS_INSTANCE_DIR === '/i' && seen[0].env.NEURALOS_PROBE === 'transactions_count' && seen[0].env.NEURALOS_ARGS === '{"limit":5}',
    'probe name and args travel through the environment, never the command line',
  )

  const failed = await executeProbe((() => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'boom' })) as never, cfg, '/i', 'p', {})
  ok((failed as { error?: string }).error === 'probe exited 1: boom', 'probe failure surfaces as data')
}

// ---------------------------------------------------------------------------
// 7. Graph direct execution + admin interlock.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'neuralos-graph-'))
  writeFileSync(
    join(dir, 'needle_menu.json'),
    JSON.stringify([{ name: 'cb_graph_overview' }, { name: 'cb_graph_neighbors' }, { name: 'transactions_count' }]),
  )
  const cfg = resolveConfig({}, {})
  const exec = () => Promise.resolve({ ok: true, code: 0, stdout: '{"nodes":[]}', stderr: '' })

  const overview = await graphProbe(exec, cfg, dir, { op: 'overview' })
  ok((overview as { probe?: string }).probe === 'cb_graph_overview' && (overview as { nodes?: unknown[] }).nodes?.length === 0, 'graph overview executes the probe directly by name')
  const neighbors = await graphProbe(exec, cfg, dir, { op: 'neighbors', node: '4001234567' })
  ok((neighbors as { probe?: string }).probe === 'cb_graph_neighbors', 'graph neighbors executes by name (numeric fragments bypass engine grounding)')
  const missingOp = await graphProbe(exec, cfg, dir, { op: 'connect', a: 'x', b: 'y' })
  ok(
    (missingOp as { error?: string }).error === 'this instance has no connect graph probe' &&
      Array.isArray((missingOp as { available_graph_probes?: string[] }).available_graph_probes),
    'a missing graph op lists what exists instead of guessing',
  )

  const admin = await adminProbe(exec, cfg, dir, 'aws_tag', { confirm: 'yes' })
  ok(admin.admin === true && admin.probe === 'aws_tag', 'admin wraps the result with the probe name and admin flag')
  const badName = await adminProbe(exec, cfg, dir, 'rm -rf', {})
  ok((badName as { error?: string }).error === 'invalid probe name: rm -rf', 'admin rejects probe names that are not identifiers')
}

// ---------------------------------------------------------------------------
// 8. Engine resolution: settings override wins; auto-download provisions the
//    cache via an injected fetch (no network in CI); idempotent on re-run.
// ---------------------------------------------------------------------------
{
  const explicitDir = mkdtempSync(join(tmpdir(), 'neuralos-explicit-'))
  writeFileSync(join(explicitDir, 'needle'), 'fake-engine')
  writeFileSync(join(explicitDir, 'needle3.cact'), 'fake-weights')
  const cacheAlt = mkdtempSync(join(tmpdir(), 'neuralos-cache-alt-'))
  writeFileSync(join(cacheAlt, 'engine-macos-arm64'), 'cache-engine')
  writeFileSync(join(cacheAlt, 'needle3.cact'), 'cache-weights')
  const explicit = await resolveEngine(
    resolveConfig({ getSettings: () => ({ neuralos: { engineBin: join(explicitDir, 'needle'), engineWeights: join(explicitDir, 'needle3.cact'), cacheDir: cacheAlt } }) }, {}),
    { platform: 'darwin', arch: 'arm64' },
  )
  ok(explicit.engineBin === join(explicitDir, 'needle'), 'explicit settings engine wins over a populated cache')

  const cache = mkdtempSync(join(tmpdir(), 'neuralos-cache-'))
  const downloads: string[] = []
  const fetchImpl = async (url: string, target: string) => {
    downloads.push(url)
    writeFileSync(target, `fake:${url}`)
  }
  const cfg = resolveConfig({ getSettings: () => ({}) }, { NEURALOS_INSTANCES_DIR: mkdtempSync(join(tmpdir(), 'neuralos-none-')), NEURALOS_CACHE_DIR: cache })
  const first = await ensureEngine({ platform: 'darwin', arch: 'arm64', cacheDir: cache, fetchImpl })
  ok(first.engineBin === join(cache, 'engine-macos-arm64') && first.engineWeights === join(cache, 'needle3.cact'), 'ensureEngine provisions weights + per-arch engine into the cache', JSON.stringify(first))
  ok(downloads.length === 2 && downloads[0] === `${HF_BASE}/needle3.cact` && downloads[1].includes('macos-arm64/needle'), 'downloads come from the public Cactus-Compute/needle3 URLs')
  ok(existsSync(join(cache, 'engine-macos-arm64')), 'the engine file exists on disk after provisioning')

  const second = await ensureEngine({ platform: 'darwin', arch: 'arm64', cacheDir: cache, fetchImpl })
  ok(second.engineBin === first.engineBin && downloads.length === 2, 'provisioning is idempotent — no re-download when cached')

  // resolution now finds the cache without any download
  const resolved = await resolveEngine(cfg, { platform: 'darwin', arch: 'arm64' })
  ok(resolved.engineBin === join(cache, 'engine-macos-arm64'), 'resolveEngine picks the provisioned cache copy')
}

// ---------------------------------------------------------------------------
// 9. Tool registration + the admin confirm interlock at the tool layer.
// ---------------------------------------------------------------------------
{
  const registered: Array<{ name: string; params: Record<string, unknown>; handler: (args: unknown) => Promise<unknown> }> = []
  const logged: string[] = []
  register({
    registerTool: (t) => registered.push(t as never),
    log: (l: string) => logged.push(l),
    getSettings: () => ({}),
  })
  ok(
    registered.map((t) => t.name).sort().join(',') === 'neuralos_admin,neuralos_ask,neuralos_graph,neuralos_list_instances',
    'register() wires exactly the four neuralos tools',
  )
  const admin = registered.find((t) => t.name === 'neuralos_admin')
  const denied = (await admin.handler({ instance: 'aws', probe: 'aws_power', confirm: 'no' })) as { error?: string }
  ok(denied.error?.includes('confirm="yes"'), 'the tool layer refuses admin without confirm="yes"')
  const unknown = registered.find((t) => t.name === 'neuralos_ask')
  const answered = (await unknown.handler({ instance: 'does-not-exist', question: 'x' })) as { error?: string }
  ok(answered.error?.includes("no instance named 'does-not-exist'"), 'ask answers an unknown instance as data')
  ok(logged.some((l) => l.includes('registered neuralos tools')), 'the plugin announces registration through ctx.log')

  // the enabled=false settings gate: the Settings panel switch is honest
  const off: Array<{ name: string }> = []
  register({
    registerTool: (t) => off.push(t as never),
    log: () => {},
    getSettings: () => ({ neuralos: { enabled: false } }),
  })
  ok(off.length === 0, 'enabled=false registers zero tools')
}

// ---------------------------------------------------------------------------
// 10. Digest truncation keeps tool results bounded.
// ---------------------------------------------------------------------------
{
  const big = { rows: 'x'.repeat(20_000) }
  const text = truncate(big, 6000)
  ok(text.length < 21_000 && text.includes('truncated at 6000 chars'), 'truncate caps large digests with an honest marker')
  ok(truncate('small') === 'small', 'small digests pass through untouched')
}

// ---------------------------------------------------------------------------
// 11. The REAL defaultExec forwards opts.env (probe transport) to the child
//     while keeping the parent environment (PATH etc.) intact.
// ---------------------------------------------------------------------------
{
  const exec = defaultExec()
  const out = await exec(process.execPath, ['-e', 'console.log(process.env.NEURALOS_SPEC_PROBE ?? "missing")'], { env: { NEURALOS_SPEC_PROBE: 'forwarded' } })
  ok(out.code === 0 && out.stdout.trim() === 'forwarded', 'defaultExec forwards opts.env to the child process')
  const plain = await exec(process.execPath, ['-e', 'console.log(Boolean(process.env.PATH))'])
  ok(plain.code === 0 && plain.stdout.trim() === 'true', 'defaultExec keeps the parent environment for plain calls')
}

// ---------------------------------------------------------------------------
// 12. The lost-exec-bit family (v3.9.2). curl -o / electron-builder
//     extraResources ship engines with mode 0644; spawning them dies with
//     EACCES and an EMPTY stderr. Resolution must check executability, not
//     existence — a broken bundle must never shadow a runnable engine.
// ---------------------------------------------------------------------------
{
  // 12a. A 0644 bundled engine is skipped, and the next candidate wins.
  const root = mkdtempSync(join(tmpdir(), 'neuralos-execbit-'))
  const resources = join(root, 'resources')
  const cache = join(root, 'cache')
  const instances = join(root, 'instances')
  mkdirSync(join(resources, 'neuralos'), { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(join(instances, 'engine'), { recursive: true })
  // bundled copy: present but NOT executable (the v3.9.1 bug)
  writeFileSync(join(resources, 'neuralos', 'engine-macos-arm64'), 'bundled-broken')
  writeFileSync(join(resources, 'neuralos', 'needle3.cact'), 'bundled-weights')
  chmodSync(join(resources, 'neuralos', 'engine-macos-arm64'), 0o644)
  // fleet-convention copy: executable
  writeFileSync(join(instances, 'engine', 'needle'), '#!/bin/sh\necho ok')
  writeFileSync(join(instances, 'engine', 'needle3.cact'), 'fleet-weights')
  chmodSync(join(instances, 'engine', 'needle'), 0o755)

  const cfg = resolveConfig({ getSettings: () => ({}) }, { NEURALOS_INSTANCES_DIR: instances, NEURALOS_CACHE_DIR: cache, NEURALOS_AUTO_DOWNLOAD: '0' })
  const resolved = await resolveEngine(cfg, { platform: 'darwin', arch: 'arm64', resourcesPath: resources })
  ok(resolved.engineBin === join(instances, 'engine', 'needle'), 'a 0644 bundled engine is skipped for the runnable fleet engine', JSON.stringify(resolved))

  // 12b. chmod recovery: a 0644 engine we OWN is fixed in place, not skipped.
  const ownedDir = mkdtempSync(join(tmpdir(), 'neuralos-owned-'))
  writeFileSync(join(ownedDir, 'engine-macos-arm64'), 'owned')
  writeFileSync(join(ownedDir, 'needle3.cact'), 'owned-weights')
  chmodSync(join(ownedDir, 'engine-macos-arm64'), 0o644)
  const cfgOwned = resolveConfig({ getSettings: () => ({}) }, { NEURALOS_INSTANCES_DIR: join(root, 'nope'), NEURALOS_CACHE_DIR: ownedDir, NEURALOS_AUTO_DOWNLOAD: '0' })
  const recovered = await resolveEngine(cfgOwned, { platform: 'darwin', arch: 'arm64' })
  ok(recovered.engineBin === join(ownedDir, 'engine-macos-arm64'), 'a 0644 engine we own is chmod-recovered instead of skipped', JSON.stringify(recovered))

  // 12c. EACCES at spawn time is named, with the fix in the message.
  const denied = await engineSelect(
    () => Promise.resolve({ ok: false, code: 'EACCES', stdout: '', stderr: '' }),
    { engineBin: '/broken/engine', engineWeights: '/w' },
    '/m',
    'q',
  )
  ok(
    (denied as { error?: string }).error?.includes('engine not executable') && (denied as { error?: string }).error?.includes('chmod +x'),
    'EACCES spawn failure names the fix (chmod +x / engineBin override)',
    JSON.stringify(denied),
  )

  // 12d. A non-EACCES crash keeps the original shape.
  const crash = await engineSelect(
    () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'boom' }),
    { engineBin: '/e', engineWeights: '/w' },
    '/m',
    'q',
  )
  ok((crash as { error?: string }).error === 'engine exited 1: boom', 'non-EACCES crashes keep the engine exited N: stderr shape')

  // 12e. defaultExec preserves a real EACCES code from the OS.
  const realExec = defaultExec()
  const noExecFile = join(root, 'not-executable')
  writeFileSync(noExecFile, 'x')
  chmodSync(noExecFile, 0o644)
  const eacc = await realExec(noExecFile, [])
  ok(eacc.code === 'EACCES', 'defaultExec surfaces EACCES as the code (not a generic 1)', JSON.stringify(eacc.code))

  // 12f. defaultExec reports timeout kills honestly.
  const slow = await realExec(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 })
  ok(String(slow.code).includes('killed') || String(slow.code).includes('ETIMEDOUT'), 'a timeout kill is reported as killed/ETIMEDOUT, not exit 1', JSON.stringify(slow.code))

  // 12g. truncate(undefined) must not throw (JSON.stringify(undefined) is undefined).
  const undef = truncate(undefined as never)
  ok(undef === 'null', 'truncate(undefined) renders honestly instead of crashing', String(undef))

  // 12h. A corrupt menu is data for graphProbe, never an exception.
  const corruptDir = mkdtempSync(join(tmpdir(), 'neuralos-corrupt-'))
  writeFileSync(join(corruptDir, 'needle_menu.json'), 'NOT JSON {{{')
  const corrupt = await graphProbe(() => Promise.resolve({ ok: true, code: 0, stdout: '{}', stderr: '' }), resolveConfig({}, {}), corruptDir, { op: 'overview' })
  ok((corrupt as { error?: string }).error?.includes('instance menu unreadable'), 'graphProbe reports a corrupt menu as data')

  // 12i. A menu that is valid JSON but not an array is also rejected as data.
  const nonArrayDir = mkdtempSync(join(tmpdir(), 'neuralos-nonarray-'))
  writeFileSync(join(nonArrayDir, 'needle_menu.json'), '{"not":"an array"}')
  const nonArray = await graphProbe(() => Promise.resolve({ ok: true, code: 0, stdout: '{}', stderr: '' }), resolveConfig({}, {}), nonArrayDir, { op: 'overview' })
  ok((nonArray as { error?: string }).error?.includes('instance menu unreadable'), 'a non-array menu is rejected as data')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('neuralos: ALL TESTS PASSED')