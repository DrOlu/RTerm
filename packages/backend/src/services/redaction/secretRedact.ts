/**
 * Redact secrets in logs, tool output, and OTel (v3.8.0).
 * Never send raw passwords/tokens to the model or UI.
 */

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(gys_at_[A-Za-z0-9_-]{16,})\b/g, label: 'RTERM_TOKEN' },
  { re: /\b(ghp_[A-Za-z0-9]{20,})\b/g, label: 'GITHUB_PAT' },
  { re: /\b(sk-[A-Za-z0-9_-]{20,})\b/g, label: 'API_KEY' },
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, label: 'AWS_KEY' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
  { re: /(password|passwd|pwd|secret|token)\s*[:=]\s*["']?([^\s"']{6,})/gi, label: 'CREDENTIAL' },
]

export function redactText(input: string, extraValues: string[] = []): string {
  let out = String(input ?? '')
  for (const v of extraValues) {
    const t = String(v || '')
    if (t.length < 4) continue
    out = out.split(t).join(`[REDACTED]`)
  }
  for (const p of PATTERNS) {
    out = out.replace(p.re, `[REDACTED:${p.label}]`)
  }
  return out
}

/** Resolve secretRef: if value looks like vault:KEY, return { ref, lookup }. */
export function parseSecretRef(value: unknown): { ref: string } | null {
  const s = String(value ?? '').trim()
  if (s.startsWith('vault:') && s.length > 6) return { ref: s.slice(6) }
  if (s.startsWith('secretRef:') && s.length > 10) return { ref: s.slice(10) }
  return null
}

export async function materializeSecret(
  value: string | undefined,
  getSecret: (key: string) => Promise<string | undefined>,
): Promise<string> {
  const raw = String(value ?? '')
  const parsed = parseSecretRef(raw)
  if (!parsed) return raw
  const got = await getSecret(parsed.ref)
  if (!got) throw new Error(`secretRef not found: ${parsed.ref}`)
  return got
}
