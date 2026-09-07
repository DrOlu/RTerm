/**
 * NTLMv2 Type 1 / Type 2 / Type 3 — MS-NLMP. No deps.
 * NTHash = MD4(UTF-16LE(password)); NTLMv2 hash = HMAC-MD5(NTHash, UTF-16LE(USER + Domain)).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { md4, utf16le } from './md4'

export const NTLM_SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii')

/** Flags we advertise (Unicode + NTLM + target info + extended session security + 128). */
export const NTLM_FLAGS =
  0x00000001 | // UNICODE
  0x00000004 | // REQUEST_TARGET
  0x00000200 | // NTLM
  0x00008000 | // ALWAYS_SIGN
  0x00080000 | // TARGET_INFO
  0x00020000 | // NTLM2 / EXTENDED_SESSIONSECURITY
  0x20000000 | // 128
  0x80000000   // 56
  // VERSION (0x02000000) omitted — we don't emit the 8-byte version struct.

export interface NtlmCredentials {
  username: string
  password: string
  domain: string
  workstation?: string
}

export interface Type2Challenge {
  flags: number
  challenge: Buffer
  targetName: string
  targetInfo: Buffer
}

function secBuf(len: number, offset: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(len, 0)
  b.writeUInt16LE(len, 2)
  b.writeUInt32LE(offset, 4)
  return b
}

function readSecBuf(buf: Buffer, at: number): { len: number; offset: number; data: Buffer } {
  const len = buf.readUInt16LE(at)
  const offset = buf.readUInt32LE(at + 4)
  const data = offset + len <= buf.length ? buf.subarray(offset, offset + len) : Buffer.alloc(0)
  return { len, offset, data }
}

export function parseUsername(username: string, domain?: string): { user: string; domain: string } {
  if (username.includes('\\')) {
    const [d, u] = username.split('\\')
    return { user: u || username, domain: d || domain || '' }
  }
  if (username.includes('@')) {
    const [u, d] = username.split('@')
    return { user: u || username, domain: d || domain || '' }
  }
  return { user: username, domain: domain || '' }
}

export function createType1(domain = '', workstation = ''): Buffer {
  const d = Buffer.from(domain.toUpperCase(), 'ascii')
  const w = Buffer.from(workstation.toUpperCase(), 'ascii')
  const headerLen = 32
  const flags = NTLM_FLAGS | (d.length ? 0x00001000 : 0) | (w.length ? 0x00002000 : 0)
  const out = Buffer.alloc(headerLen + d.length + w.length)
  NTLM_SIGNATURE.copy(out)
  out.writeUInt32LE(1, 8)
  out.writeUInt32LE(flags >>> 0, 12)
  secBuf(d.length, headerLen).copy(out, 16)
  secBuf(w.length, headerLen + d.length).copy(out, 24)
  d.copy(out, headerLen)
  w.copy(out, headerLen + d.length)
  return out
}

export function parseType2(buf: Buffer): Type2Challenge {
  if (buf.length < 32 || buf.subarray(0, 8).toString('ascii') !== 'NTLMSSP\0') {
    throw new Error('NTLM Type 2: bad signature')
  }
  if (buf.readUInt32LE(8) !== 2) throw new Error('NTLM Type 2: unexpected message type')
  const flags = buf.readUInt32LE(20)
  const challenge = Buffer.from(buf.subarray(24, 32))
  const target = readSecBuf(buf, 12)
  const targetName = target.data.toString('utf16le')
  let targetInfo = Buffer.alloc(0)
  if (buf.length >= 48) {
    targetInfo = Buffer.from(readSecBuf(buf, 40).data)
  }
  return { flags, challenge, targetName, targetInfo }
}

function windowsFiletimeNow(): Buffer {
  // 100-ns intervals since 1601-01-01
  const EPOCH_DIFF = 11644473600000n // ms between 1601 and 1970
  const now = BigInt(Date.now())
  const ft = (now + EPOCH_DIFF) * 10000n
  const b = Buffer.alloc(8)
  b.writeUInt32LE(Number(ft & 0xffffffffn), 0)
  b.writeUInt32LE(Number((ft >> 32n) & 0xffffffffn), 4)
  return b
}

export function ntHash(password: string): Buffer {
  return md4(utf16le(password))
}

export function ntlmv2Hash(password: string, username: string, domain: string): Buffer {
  return createHmac('md5', ntHash(password))
    .update(utf16le(username.toUpperCase() + domain))
    .digest()
}

export function createType3(type2: Type2Challenge, creds: NtlmCredentials, clientChallenge?: Buffer): Buffer {
  const user = creds.username
  const domain = creds.domain
  const workstation = creds.workstation || ''
  const cc = clientChallenge && clientChallenge.length === 8 ? clientChallenge : randomBytes(8)

  const v2 = ntlmv2Hash(creds.password, user, domain)

  // NTLMv2 blob
  const blob = Buffer.concat([
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    windowsFiletimeNow(),
    cc,
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    type2.targetInfo,
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ])
  const ntProof = createHmac('md5', v2).update(Buffer.concat([type2.challenge, blob])).digest()
  const ntResponse = Buffer.concat([ntProof, blob])

  // LMv2
  const lmProof = createHmac('md5', v2).update(Buffer.concat([type2.challenge, cc])).digest()
  const lmResponse = Buffer.concat([lmProof, cc])

  const domainB = utf16le(domain.toUpperCase())
  const userB = utf16le(user)
  const wsB = utf16le(workstation.toUpperCase())

  const headerLen = 64
  const lmOff = headerLen
  const ntOff = lmOff + lmResponse.length
  const dOff = ntOff + ntResponse.length
  const uOff = dOff + domainB.length
  const wOff = uOff + userB.length
  const total = wOff + wsB.length

  const out = Buffer.alloc(total)
  NTLM_SIGNATURE.copy(out)
  out.writeUInt32LE(3, 8)
  secBuf(lmResponse.length, lmOff).copy(out, 12)
  secBuf(ntResponse.length, ntOff).copy(out, 20)
  secBuf(domainB.length, dOff).copy(out, 28)
  secBuf(userB.length, uOff).copy(out, 36)
  secBuf(wsB.length, wOff).copy(out, 44)
  secBuf(0, total).copy(out, 52) // session key
  out.writeUInt32LE(type2.flags >>> 0, 60)
  lmResponse.copy(out, lmOff)
  ntResponse.copy(out, ntOff)
  domainB.copy(out, dOff)
  userB.copy(out, uOff)
  wsB.copy(out, wOff)
  return out
}

export function toBase64(buf: Buffer): string {
  return buf.toString('base64')
}

export function fromBase64(s: string): Buffer {
  return Buffer.from(s, 'base64')
}
