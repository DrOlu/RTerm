/**
 * neuralos — neuralOS instances as RTerm agent tools.
 *
 * neuralOS instances (~/neuralos-instances) are on-device data agents: a
 * verified menu of probes over a real data source (databases, APIs, log
 * sets), selected by the 121M neuralOS engine and executed by each
 * instance's Python bridge. This plugin wires four agent tools:
 *
 *   neuralos_list_instances — what can be queried
 *   neuralos_ask            — plain-English question -> verified digest
 *   neuralos_graph          — relationship maps (overview/neighbors/connect)
 *   neuralos_admin          — write probes, confirm='yes' interlocked
 *
 * The engine ships with the RTerm desktop bundle ({resourcesPath}/neuralos);
 * the standalone backend auto-provisions ~/.cache/neuralos on first use
 * (one ~36 MB fetch from HuggingFace, offline forever after).
 *
 * Config (settings.neuralos, or env NEURALOS_*):
 *   instancesDir  — instances root (default ~/neuralos-instances)
 *   pythonBin    — interpreter with pydantic for the bridges (default python3)
 *   engineBin / engineWeights — explicit engine override
 *   autoDownload — provision the shared cache when nothing local (default true)
 */

import { resolveConfig, listInstances, instanceDirFor, resolveEngine, engineSelect, executeProbe, graphProbe, adminProbe, truncate, defaultExec } from './neuralosEngine.mjs'

export { resolveConfig } from './neuralosEngine.mjs'

export function register(ctx) {
  const cfg = resolveConfig(ctx)
  const exec = defaultExec()
  const log = (line) => {
    try {
      if (typeof ctx.log === 'function') ctx.log(`[neuralos] ${line}`)
    } catch { /* logging must never break a tool */ }
  }

  registerList(ctx, cfg, log)
  registerAsk(ctx, cfg, exec, log)
  registerGraph(ctx, cfg, exec, log)
  registerAdmin(ctx, cfg, exec, log)

  log('registered neuralos tools (list_instances, ask, graph, admin)')
}

function registerList(ctx, cfg, log) {
  ctx.registerTool({
    name: 'neuralos_list_instances',
    description:
      'List the available neuralOS instances (on-device data agents). Each instance is a verified menu of probes over a real data source (a database, API, or file set). Use this first to see what can be queried.',
    params: {},
    handler: async () => {
      const result = await listInstances(cfg)
      log('list_instances')
      return result
    },
  })
}

function registerAsk(ctx, cfg, exec, log) {
  ctx.registerTool({
    name: 'neuralos_ask',
    description:
      'Ask a neuralOS instance a question in plain English. The on-device engine selects the probe, the instance bridge executes it against the real data source, and a verified digest comes back. Route data questions through this instead of querying the source directly.',
    params: {
      instance: { type: 'string', description: 'instance name from neuralos_list_instances' },
      question: { type: 'string', description: 'the question in plain English, verbatim' },
    },
    handler: async (p) => {
      const instance = String(p?.instance ?? '')
      const question = String(p?.question ?? '')
      const dir = await instanceDirFor(cfg, instance)
      if (typeof dir !== 'string') return dir
      const engine = await resolveEngine(cfg)
      if (engine.error) return engine
      const selection = await engineSelect(exec, engine, `${dir}/needle_menu.json`, question, { timeoutMs: cfg.timeoutMs })
      if (selection.error) return { instance, question, ...selection }
      const result = await executeProbe(exec, cfg, dir, selection.pick, selection.args, { timeoutMs: cfg.timeoutMs })
      log(`ask ${instance} -> ${selection.pick} (conf ${selection.confidence})`)
      return truncate({ instance, question, pick: selection.pick, confidence: selection.confidence, result })
    },
  })
}

function registerGraph(ctx, cfg, exec, log) {
  ctx.registerTool({
    name: 'neuralos_graph',
    description:
      'Relationship questions over an instance: overview (the verified entity/edge map), neighbors (one-hop adjacency for a node fragment), or connect (path between two entities). Executes the graph probe directly.',
    params: {
      instance: { type: 'string', description: 'instance name' },
      op: { type: 'string', description: 'overview | neighbors | connect' },
      node: { type: 'string', description: 'node fragment for neighbors', optional: true },
      a: { type: 'string', description: 'first entity for connect', optional: true },
      b: { type: 'string', description: 'second entity for connect', optional: true },
    },
    handler: async (p) => {
      const dir = await instanceDirFor(cfg, String(p?.instance ?? ''))
      if (typeof dir !== 'string') return dir
      const result = await graphProbe(exec, cfg, dir, { op: String(p?.op ?? 'overview'), node: p?.node, a: p?.a, b: p?.b })
      log(`graph ${p?.op}`)
      return truncate(result)
    },
  })
}

function registerAdmin(ctx, cfg, exec, log) {
  ctx.registerTool({
    name: 'neuralos_admin',
    description:
      'Execute a WRITE/admin probe on an instance (boot a server, tag a resource, purge DNS). Destructive and reversible only per the instance design; the confirm parameter must be the literal string "yes" — that is the operator interlock. Read-only questions must use neuralos_ask instead.',
    params: {
      instance: { type: 'string', description: 'instance name' },
      probe: { type: 'string', description: 'admin probe name, e.g. aws_power' },
      args: { type: 'object', description: 'probe arguments as JSON', optional: true },
      confirm: { type: 'string', description: 'must be the literal "yes"' },
    },
    handler: async (p) => {
      if (p?.confirm !== 'yes') return { error: 'admin probes require confirm="yes" — restate what you intend to run and pass confirm="yes"' }
      const dir = await instanceDirFor(cfg, String(p?.instance ?? ''))
      if (typeof dir !== 'string') return dir
      const result = await adminProbe(exec, cfg, dir, String(p?.probe ?? ''), p?.args ?? {})
      log(`admin ${p?.probe} on ${p?.instance}`)
      return truncate(result)
    },
  })
}

export function unregister() {
  /* tools deregister with the plugin record; nothing to stop here */
}