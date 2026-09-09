/**
 * Network device: running vs startup + CDP/LLDP inventory (v3.8.0).
 */

export function parseCdpNeighbors(showCdp: string): Array<{ device: string; localIntf: string; remoteIntf: string }> {
  const out: Array<{ device: string; localIntf: string; remoteIntf: string }> = []
  const blocks = showCdp.split(/Device ID:/i)
  for (const b of blocks.slice(1)) {
    const device = (b.split('\n')[0] || '').trim()
    const local = /Interface:\s*(\S+)/i.exec(b)?.[1] ?? ''
    const remote = /Port ID[^:]*:\s*(\S+)/i.exec(b)?.[1] ?? ''
    if (device) out.push({ device, localIntf: local, remoteIntf: remote })
  }
  return out
}

export function configDiff(running: string, startup: string): { changed: boolean; unified: string } {
  const a = running.replace(/\r/g, '').trimEnd()
  const b = startup.replace(/\r/g, '').trimEnd()
  if (a === b) return { changed: false, unified: '' }
  return { changed: true, unified: `--- startup\n+++ running\n-${b.slice(0, 200)}\n+${a.slice(0, 200)}` }
}

export function inConfigMode(prompt: string): boolean {
  return /\(config[^)]*\)#\s*$/.test(prompt)
}
