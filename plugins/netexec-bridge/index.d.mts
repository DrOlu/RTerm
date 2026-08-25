// netexec-bridge plugin type declarations
export function register(ctx: any): void
export function buildNetexecCommand(opts: {
  protocol: string
  targets: string
  action: string
  extraArgs?: string[]
  username?: string
  passwordRef?: string
  domain?: string
  timeoutSec?: number
}): { cmd: string; args: string[] }
export function validateTargets(targets: string | null | undefined, allowlist: string[] | null | undefined): { ok: boolean; reason?: string; targets?: string[] }
export function parseNetexecOutput(raw: string | null | undefined): {
  hosts: Array<{ ip: string; hostname: string; status: string; detail?: string }>
  authSuccess: Array<{ protocol: string; ip: string; port: number; hostname: string; detail: string; pwned: boolean }>
  authFailed: Array<{ protocol: string; ip: string; port: number; hostname: string; detail: string }>
  errors: string[]
  raw: string
}
export function buildSprayPlan(opts: {
  targets: string
  usernames: string[]
  attemptsPerUser?: number
  delayMs?: number
  jitterMs?: number
}): { targets: string; steps: Array<{ username: string; attempt: number; waitBeforeMs: number }>; totalAttempts: number; note: string }
export default any
