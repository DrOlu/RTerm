import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { md4, utf16le } from './md4'

function hex(b: Buffer): string {
  return b.toString('hex')
}

describe('md4 (RFC 1320)', () => {
  it('empty string', () => {
    assert.equal(hex(md4(Buffer.from(''))), '31d6cfe0d16ae931b73c59d7e0c089c0')
  })
  it('a', () => {
    assert.equal(hex(md4(Buffer.from('a'))), 'bde52cb31de33e46245e05fbdbd6fb24')
  })
  it('abc', () => {
    assert.equal(hex(md4(Buffer.from('abc'))), 'a448017aaf21d8525fc10ae87aa6729d')
  })
  it('message digest', () => {
    assert.equal(hex(md4(Buffer.from('message digest'))), 'd9130a8164549fe818874806e1c7014b')
  })
  it('utf16le encodes as little-endian code units', () => {
    assert.deepEqual([...utf16le('Ab')], [0x41, 0x00, 0x62, 0x00])
  })
})
