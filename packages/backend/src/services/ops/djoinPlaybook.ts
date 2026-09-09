/**
 * Offline domain join playbook (v3.8.0).
 * Live Add-Computer failed on this estate (NetUseAdd 64 / IPC$). djoin does not need SMB.
 */

export interface DjoinPlan {
  domain: string
  machine: string
  provisionOn: string
  applyOn: string
  steps: string[]
}

export function planOfflineJoin(opts: { domain: string; machine: string; dcConnection: string; memberConnection: string }): DjoinPlan {
  const domain = String(opts.domain || '').trim()
  const machine = String(opts.machine || '').trim()
  if (!domain || !machine) throw new Error('domain and machine required')
  return {
    domain,
    machine,
    provisionOn: opts.dcConnection,
    applyOn: opts.memberConnection,
    steps: [
      `On ${opts.dcConnection}: djoin /provision /domain ${domain} /machine ${machine} /savefile C:\\temp\\${machine}.odj`,
      `Copy blob to ${opts.memberConnection} (no SMB — PSRP/WinRM file or pypsrp)`,
      `On ${opts.memberConnection}: djoin /requestODJ /loadfile C:\\temp\\${machine}.odj /localos /windowspath C:\\Windows`,
      `Restart ${opts.memberConnection}`,
      `Verify PartOfDomain and Get-ADComputer ${machine}`,
    ],
  }
}

export function djoinProvisionCommand(domain: string, machine: string, savefile = 'C:\\temp\\odj.blob'): string {
  return `djoin /provision /domain ${domain} /machine ${machine} /savefile ${savefile}`
}

export function djoinRequestCommand(loadfile = 'C:\\temp\\odj.blob'): string {
  return `djoin /requestODJ /loadfile ${loadfile} /localos /windowspath C:\\Windows`
}
