import type { PlaybookParam, PlaybookStep } from '../../types'

/**
 * Runbook engine helpers — parameterized playbooks, secret masking, idempotent
 * desired-state checks, and cross-host orchestration variable capture.
 *
 * These are pure functions, fully unit-testable, used by the playbook runner.
 */

export type ParamValues = Record<string, string>

/** Resolve the effective value of every declared param: supplied value wins,
 * else the declared default. Throws for a missing required param. */
export function resolveParams(params: PlaybookParam[] | undefined, supplied: ParamValues): ParamValues {
  const out: ParamValues = {}
  for (const p of params ?? []) {
    const v = supplied[p.name]
    if (v !== undefined && v !== '') {
      out[p.name] = v
    } else if (p.defaultValue !== undefined) {
      out[p.name] = p.defaultValue
    } else {
      throw new Error(`Playbook parameter "${p.name}" has no value and no default.`)
    }
  }
  return out
}

/** Substitute {{name}} and {{param.name}} placeholders in a command string
 * using the run's param + captured-variable maps. Unknown placeholders are left
 * untouched (so an unrelated {{var}} in a config body is never clobbered). */
export function substituteVars(command: string, vars: Record<string, string>): string {
  return command.replace(/\{\{\s*(?:param\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m
  })
}

const MASK = '••••••'

/** Build a display-safe copy of a param value map with secrets masked. */
export function maskSecrets(params: PlaybookParam[] | undefined, values: ParamValues): ParamValues {
  const secretNames = new Set((params ?? []).filter((p) => p.secret).map((p) => p.name))
  const out: ParamValues = {}
  for (const [k, v] of Object.entries(values)) {
    out[k] = secretNames.has(k) ? MASK : v
  }
  return out
}

/** Mask any occurrence of secret values inside an arbitrary text blob (so a
 * leaked secret never lands in a run record or log). */
export function scrubSecrets(text: string, params: PlaybookParam[] | undefined, values: ParamValues): string {
  const secretNames = new Set((params ?? []).filter((p) => p.secret).map((p) => p.name))
  let out = text
  for (const name of secretNames) {
    const v = values[name]
    if (v) out = out.split(v).join(MASK)
  }
  return out
}

/** Extract a named variable from a step's output using a regex (with capture
 * group 1) or a substring pattern. Returns undefined when not found. */
export function captureVar(output: string, pattern: string, useRegex?: boolean): string | undefined {
  if (useRegex) {
    try {
      const m = output.match(new RegExp(pattern, 'm'))
      return m ? (m[1] ?? m[0]) : undefined
    } catch {
      return undefined
    }
  }
  // substring pattern: take the rest of the line after the pattern
  const idx = output.indexOf(pattern)
  if (idx < 0) return undefined
  const rest = output.slice(idx + pattern.length)
  const line = rest.split('\n', 1)[0]
  return line.trim() === '' ? undefined : line.trim()
}

/** Decide whether a step is already in its desired state (idempotent skip). */
export async function checkDesiredState(
  step: PlaybookStep,
  runCheck: (command: string) => Promise<{ stdout: string; exitCode?: number }>,
): Promise<boolean> {
  const ds = step.desiredState
  if (!ds) return false
  const cmd = (ds.command ?? '').trim()
  if (!cmd) return false
  try {
    const res = await runCheck(cmd)
    const out = res.stdout ?? ''
    if (ds.expectMode === 'regex') {
      try { return new RegExp(ds.expect, 'm').test(out) } catch { return out.includes(ds.expect) }
    }
    return out.includes(ds.expect)
  } catch {
    return false
  }
}
