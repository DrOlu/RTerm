import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createType1,
  parseType2,
  createType3,
  parseUsername,
  ntHash,
  ntlmv2Hash,
  NTLM_SIGNATURE,
} from './ntlm'

describe('NTLMv2 (MS-NLMP)', () => {
  it('parseUsername splits DOMAIN\\user, user@domain, and bare user', () => {
    assert.deepEqual(parseUsername('CORP\\alice'), { user: 'alice', domain: 'CORP' })
    assert.deepEqual(parseUsername('alice@corp.local'), { user: 'alice', domain: 'corp.local' })
    assert.deepEqual(parseUsername('alice', 'WORKGROUP'), { user: 'alice', domain: 'WORKGROUP' })
    assert.deepEqual(parseUsername('alice'), { user: 'alice', domain: '' })
  })

  it('createType1 has NTLMSSP signature and type=1', () => {
    const t1 = createType1('CORP', 'WS1')
    assert.equal(t1.subarray(0, 8).toString('ascii'), 'NTLMSSP\0')
    assert.equal(t1.readUInt32LE(8), 1)
    assert.ok(t1.length >= 32)
  })

  it('parseType2 round-trips a synthetic challenge', () => {
    // Minimal Type 2: signature + type=2 + empty target + flags + 8-byte challenge
    const buf = Buffer.alloc(48)
    NTLM_SIGNATURE.copy(buf)
    buf.writeUInt32LE(2, 8)
    buf.writeUInt16LE(0, 12) // target len
    buf.writeUInt16LE(0, 14)
    buf.writeUInt32LE(32, 16)
    buf.writeUInt32LE(0x00088205, 20)
    Buffer.from('AABBCCDD', 'ascii').copy(buf, 24)
    buf.writeUInt16LE(0, 40) // target info len
    buf.writeUInt16LE(0, 42)
    buf.writeUInt32LE(48, 44)
    const t2 = parseType2(buf)
    assert.equal(t2.challenge.toString('ascii'), 'AABBCCDD')
    assert.equal(t2.flags, 0x00088205)
  })

  it('ntHash is MD4 of UTF-16LE password (known vector: empty password)', () => {
    // MD4('') = 31d6cfe0d16ae931b73c59d7e0c089c0; utf16le('') is empty so same
    assert.equal(ntHash('').toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0')
  })

  it('ntlmv2Hash is HMAC-MD5(NTHash, USER+Domain) and is 16 bytes', () => {
    const h = ntlmv2Hash('Password', 'User', 'Domain')
    assert.equal(h.length, 16)
    // Deterministic: same inputs → same hash
    assert.equal(h.toString('hex'), ntlmv2Hash('Password', 'User', 'Domain').toString('hex'))
    // Username is uppercased inside — 'user' == 'USER'
    assert.equal(
      ntlmv2Hash('Password', 'user', 'Domain').toString('hex'),
      ntlmv2Hash('Password', 'USER', 'Domain').toString('hex'),
    )
  })

  it('createType3 produces a type-3 message with NTLMSSP signature', () => {
    const type2 = {
      flags: 0x00088205,
      challenge: Buffer.alloc(8, 0xaa),
      targetName: 'SERVER',
      targetInfo: Buffer.alloc(0),
    }
    const t3 = createType3(type2, { username: 'Administrator', password: 'x', domain: '' }, Buffer.alloc(8, 0x11))
    assert.equal(t3.subarray(0, 8).toString('ascii'), 'NTLMSSP\0')
    assert.equal(t3.readUInt32LE(8), 3)
    assert.ok(t3.length > 64)
  })
})
