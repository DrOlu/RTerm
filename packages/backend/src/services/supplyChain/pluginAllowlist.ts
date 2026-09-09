/**
 * Signed plugin / skill allowlist (v3.8.0).
 */

import { createHash, createVerify } from 'node:crypto'

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function pluginAllowed(name: string, allow: string[]): boolean {
  if (allow.includes('*')) return true
  return allow.includes(name)
}

export function verifyDetachedSignature(
  content: Buffer,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const v = createVerify('SHA256')
    v.update(content)
    v.end()
    return v.verify(publicKeyPem, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

export function sbomForFiles(files: Array<{ path: string; sha256: string }>): {
  bomFormat: string
  components: Array<{ name: string; hashes: Array<{ alg: string; content: string }> }>
} {
  return {
    bomFormat: 'CycloneDX',
    components: files.map((f) => ({
      name: f.path,
      hashes: [{ alg: 'SHA-256', content: f.sha256 }],
    })),
  }
}
