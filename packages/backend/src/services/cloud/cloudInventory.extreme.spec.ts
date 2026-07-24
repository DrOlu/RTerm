import { CloudInventory, parseAwsInstances, parseGcpInstances, parseAzureVms, type CloudAccount } from './cloudInventory'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

// ─── AWS parser ───
test('parseAwsInstances normalizes reservations→instances with tags/region/ips', () => {
  const payload = {
    Reservations: [{
      Instances: [{
        InstanceId: 'i-123', InstanceType: 't3.large',
        State: { Name: 'running' },
        Placement: { AvailabilityZone: 'us-east-1a' },
        PrivateIpAddress: '10.0.0.5', PublicIpAddress: '54.1.2.3',
        Tags: [{ Key: 'Name', Value: 'web-01' }, { Key: 'env', Value: 'prod' }],
      }],
    }],
  }
  const out = parseAwsInstances(payload, '1111')
  eq(out.length, 1)
  eq(out[0].provider, 'aws')
  eq(out[0].name, 'web-01')
  eq(out[0].region, 'us-east-1')
  eq(out[0].state, 'running')
  eq(out[0].machineType, 't3.large')
  eq(out[0].privateIp, '10.0.0.5')
  eq(out[0].publicIp, '54.1.2.3')
  eq(out[0].tags!.env, 'prod')
})
test('parseAwsInstances handles empty / missing reservations', () => {
  eq(parseAwsInstances({}, 'x'), [])
  eq(parseAwsInstances({ Reservations: null }, 'x'), [])
  eq(parseAwsInstances(undefined, 'x'), [])
})
test('parseAwsInstances falls back to instance id for name', () => {
  const out = parseAwsInstances({ Reservations: [{ Instances: [{ InstanceId: 'i-x' }] }] }, 'a')
  eq(out[0].name, 'i-x')
})

// ─── GCP parser ───
test('parseGcpInstances normalizes list with region/type/ips', () => {
  const payload = [{
    id: '555', name: 'gce-1', status: 'RUNNING',
    zone: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a',
    machineType: 'https://.../machineTypes/e2-standard-2',
    networkInterfaces: [{ networkIP: '10.1.0.4', accessConfigs: [{ natIP: '34.5.6.7' }] }],
    labels: { team: 'sre' },
  }]
  const out = parseGcpInstances(payload, 'proj')
  eq(out.length, 1)
  eq(out[0].provider, 'gcp')
  eq(out[0].region, 'us-central1')
  eq(out[0].state, 'running')
  eq(out[0].machineType, 'e2-standard-2')
  eq(out[0].privateIp, '10.1.0.4')
  eq(out[0].publicIp, '34.5.6.7')
  eq(out[0].tags!.team, 'sre')
})
test('parseGcpInstances handles items-wrapped + empty', () => {
  eq(parseGcpInstances({ items: [] }, 'p'), [])
  eq(parseGcpInstances(undefined, 'p'), [])
})

// ─── Azure parser ───
test('parseAzureVms normalizes vm list', () => {
  const payload = [{
    id: '/subscriptions/sub/resourceGroups/rg/providers/.../vm1', name: 'vm1',
    location: 'eastus', tags: { env: 'dev' },
    properties: { provisioningState: 'Succeeded', hardwareProfile: { vmSize: 'Standard_D2s_v3' } },
  }]
  const out = parseAzureVms(payload, 'sub')
  eq(out.length, 1)
  eq(out[0].provider, 'azure')
  eq(out[0].kind, 'vm')
  eq(out[0].region, 'eastus')
  eq(out[0].state, 'succeeded')
  eq(out[0].machineType, 'Standard_D2s_v3')
  eq(out[0].tags!.env, 'dev')
})
test('parseAzureVms handles value-wrapped + empty', () => {
  eq(parseAzureVms({ value: [] }, 's'), [])
  eq(parseAzureVms(undefined, 's'), [])
})

// ─── CloudInventory service ───
function acct(p: CloudAccount['provider'], id: string): CloudAccount { return { provider: p, accountId: id } }

test('addAccount requires accountId', () => {
  const inv = new CloudInventory()
  throws(() => inv.addAccount({ provider: 'aws', accountId: '' }))
})
test('sync pulls + normalizes from all accounts; errors are best-effort', async () => {
  const inv = new CloudInventory({
    now: () => 42,
    fetchAwsInstances: async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }] }),
    fetchGcpInstances: async () => { throw new Error('gcp creds missing') },
  })
  inv.addAccount(acct('aws', '1111'))
  inv.addAccount(acct('gcp', 'proj'))
  const res = await inv.sync()
  eq(res.added, 1)
  eq(res.errors.length, 1)
  ok(res.errors[0].error.includes('creds'))
  eq(inv.summary().total, 1)
  eq(inv.summary().lastSyncAt, 42)
})
test('sync with no fetcher for a provider records an error', async () => {
  const inv = new CloudInventory()
  inv.addAccount(acct('aws', 'x'))
  const res = await inv.sync()
  eq(res.errors.length, 1)
})
test('query filters by provider/state/region/tag', async () => {
  const inv = new CloudInventory({
    fetchAwsInstances: async () => ({ Reservations: [{ Instances: [
      { InstanceId: 'i-1', State: { Name: 'running' }, Placement: { AvailabilityZone: 'us-east-1a' }, Tags: [{ Key: 'env', Value: 'prod' }] },
      { InstanceId: 'i-2', State: { Name: 'stopped' }, Placement: { AvailabilityZone: 'eu-west-1b' }, Tags: [{ Key: 'env', Value: 'dev' }] },
    ] }] }),
  })
  inv.addAccount(acct('aws', 'a'))
  await inv.sync()
  eq(inv.query({ state: 'running' }).length, 1)
  eq(inv.query({ region: 'eu-west-1' }).length, 1)
  eq(inv.query({ tagKey: 'env', tagValue: 'prod' })[0].name, 'i-1')
  eq(inv.query({ provider: 'gcp' }).length, 0)
})
test('summary aggregates byProvider + byState', async () => {
  const inv = new CloudInventory({
    fetchAwsInstances: async () => ({ Reservations: [{ Instances: [
      { InstanceId: 'i-1', State: { Name: 'running' } },
      { InstanceId: 'i-2', State: { Name: 'stopped' } },
    ] }] }),
  })
  inv.addAccount(acct('aws', 'a'))
  await inv.sync()
  const s = inv.summary()
  eq(s.byProvider.aws, 2)
  eq(s.byState.running, 1)
  eq(s.byState.stopped, 1)
})
test('removeAccount drops its resources too', async () => {
  const inv = new CloudInventory({
    fetchAwsInstances: async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-1' }] }] }),
  })
  inv.addAccount(acct('aws', 'a'))
  await inv.sync()
  eq(inv.summary().total, 1)
  ok(inv.removeAccount('aws', 'a'))
  eq(inv.summary().total, 0)
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
