import { renderTemplate, diffStrings } from './templateEngine'

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }

test('interpolation + filters', () => {
  const out = renderTemplate('host {{ name }} v{{ ver | default("1.0") }}', { name: 'r1' })
  if (out !== 'host r1 v1.0') throw new Error(out)
})

test('upper/lower/length filters', () => {
  if (renderTemplate('{{ s | upper }}', { s: 'abc' }) !== 'ABC') throw new Error('upper')
  if (renderTemplate('{{ s | lower }}', { s: 'ABC' }) !== 'abc') throw new Error('lower')
  if (renderTemplate('{{ s | length }}', { s: 'abcd' }) !== '4') throw new Error('length str')
  if (renderTemplate('{{ s | length }}', { s: [1, 2, 3] }) !== '3') throw new Error('length arr')
})

test('default filter uses literal when var missing', () => {
  if (renderTemplate('{{ x | default("none") }}', {}) !== 'none') throw new Error('default literal')
  if (renderTemplate('{{ x | default("none") }}', { x: 'set' }) !== 'set') throw new Error('default present')
})

test('dotted path resolution', () => {
  const out = renderTemplate('{{ host.name }}:{{ host.port }}', { host: { name: 'r1', port: 22 } })
  if (out !== 'r1:22') throw new Error(out)
})

test('for loop over array of objects (network interfaces)', () => {
  const tpl = `{% for iface in interfaces %}interface {{ iface.name }}
 ip address {{ iface.ip }} {{ iface.mask }}
!
{% endfor %}`
  const out = renderTemplate(tpl, { interfaces: [
    { name: 'G0/0', ip: '10.0.0.1', mask: '255.255.255.0' },
    { name: 'G0/1', ip: '10.0.1.1', mask: '255.255.255.0' },
  ] })
  if (!out.includes('interface G0/0') || !out.includes('ip address 10.0.1.1')) throw new Error(out)
  if (out.split('!').length - 1 !== 2) throw new Error('expected 2 interface blocks')
})

test('for over object key/value via .items()', () => {
  const out = renderTemplate(`{% for k, v in ospf.items() %}{{ k }}={{ v }}
{% endfor %}`, { ospf: { rid: '1.1.1.1', area: '0' } })
  if (!out.includes('rid=1.1.1.1') || !out.includes('area=0')) throw new Error(out)
})

test('if/elif/else conditional', () => {
  const tpl = `{% if env == "prod" %}PROD{% elif env == "stg" %}STG{% else %}DEV{% endif %}`
  if (renderTemplate(tpl, { env: 'prod' }) !== 'PROD') throw new Error('prod')
  if (renderTemplate(tpl, { env: 'stg' }) !== 'STG') throw new Error('stg')
  if (renderTemplate(tpl, { env: 'dev' }) !== 'DEV') throw new Error('else')
})

test('truthiness if', () => {
  const tpl = `{% if ospf_enabled %}ospf on{% endif %}`
  if (renderTemplate(tpl, { ospf_enabled: true }) !== 'ospf on') throw new Error('true')
  if (renderTemplate(tpl, { ospf_enabled: false }) !== '') throw new Error('false -> empty')
})

test('nested for + if (the netstacks example)', () => {
  const tpl = `{% for interface in interfaces %}interface {{ interface.name }}
  description {{ interface.description }}
  ip address {{ interface.ip }} {{ interface.mask }}
  {% if interface.ospf_enabled %}ip ospf 1 area 0
  {% endif %}
!
{% endfor %}`
  const out = renderTemplate(tpl, { interfaces: [
    { name: 'G0/0', description: 'uplink', ip: '10.0.0.1', mask: '255', ospf_enabled: true },
    { name: 'G0/1', description: 'downlink', ip: '10.0.1.1', mask: '255', ospf_enabled: false },
  ] })
  if (!out.includes('ip ospf 1 area 0')) throw new Error('ospf should appear for enabled iface')
  if (out.split('ip ospf 1 area 0').length - 1 !== 1) throw new Error('ospf should appear exactly once')
})

test('unbalanced for throws', () => {
  let threw = false
  try { renderTemplate('{% for x in xs %}hi') } catch { threw = true }
  if (!threw) throw new Error('expected throw on unbalanced for')
})

test('unbalanced if throws', () => {
  let threw = false
  try { renderTemplate('{% if a %}hi') } catch { threw = true }
  if (!threw) throw new Error('expected throw on unbalanced if')
})

test('diffStrings produces line diff', () => {
  const d = diffStrings('a\nb\nc', 'a\nB\nc')
  if (!d.includes('- b') || !d.includes('+ B') || !d.includes('  a')) throw new Error(d)
})

function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
