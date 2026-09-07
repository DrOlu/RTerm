/**
 * RFC 1320 MD4 — Node's OpenSSL 3 build disables MD4, and NTLM needs it
 * (NTHash = MD4(UTF-16LE(password))). Pure JS, no deps.
 */
const S = [
  3, 7, 11, 19, 3, 7, 11, 19, 3, 7, 11, 19, 3, 7, 11, 19,
  3, 5, 9, 13, 3, 5, 9, 13, 3, 5, 9, 13, 3, 5, 9, 13,
  3, 9, 11, 15, 3, 9, 11, 15, 3, 9, 11, 15, 3, 9, 11, 15,
]

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function F(x: number, y: number, z: number): number {
  return ((x & y) | (~x & z)) >>> 0
}
function G(x: number, y: number, z: number): number {
  return ((x & y) | (x & z) | (y & z)) >>> 0
}
function H(x: number, y: number, z: number): number {
  return (x ^ y ^ z) >>> 0
}

export function md4(data: Buffer): Buffer {
  const origLen = data.length
  const bitLen = origLen * 8
  const padLen = (56 - ((origLen + 1) % 64) + 64) % 64
  const padded = Buffer.alloc(origLen + 1 + padLen + 8)
  data.copy(padded)
  padded[origLen] = 0x80
  padded.writeUInt32LE(bitLen >>> 0, padded.length - 8)
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000), padded.length - 4)

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const X = new Uint32Array(16)

  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) X[j] = padded.readUInt32LE(i + j * 4)
    const aa = a, bb = b, cc = c, dd = d

    // round 1
    const r1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    for (let k = 0; k < 16; k++) {
      const f = F(b, c, d)
      const t = (a + f + X[r1[k]]) >>> 0
      a = d; d = c; c = b; b = rotl(t, S[k])
    }
    // round 2
    const r2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]
    for (let k = 0; k < 16; k++) {
      const g = G(b, c, d)
      const t = (a + g + X[r2[k]] + 0x5a827999) >>> 0
      a = d; d = c; c = b; b = rotl(t, S[16 + k])
    }
    // round 3
    const r3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]
    for (let k = 0; k < 16; k++) {
      const h = H(b, c, d)
      const t = (a + h + X[r3[k]] + 0x6ed9eba1) >>> 0
      a = d; d = c; c = b; b = rotl(t, S[32 + k])
    }

    a = (a + aa) >>> 0
    b = (b + bb) >>> 0
    c = (c + cc) >>> 0
    d = (d + dd) >>> 0
  }

  const out = Buffer.alloc(16)
  out.writeUInt32LE(a, 0)
  out.writeUInt32LE(b, 4)
  out.writeUInt32LE(c, 8)
  out.writeUInt32LE(d, 12)
  return out
}

export function utf16le(s: string): Buffer {
  const buf = Buffer.alloc(s.length * 2)
  for (let i = 0; i < s.length; i++) buf.writeUInt16LE(s.charCodeAt(i), i * 2)
  return buf
}
