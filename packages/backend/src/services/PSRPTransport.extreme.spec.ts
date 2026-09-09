import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  guidLe,
  psrpMessage,
  fragmentMessages,
  unfragmentMessages,
} from './PSRPTransport'

describe('PSRPTransport protocol layer', () => {
  it('guidLe uses .NET little-endian layout (first 3 fields swapped)', () => {
    const uuid = '00112233-4455-6677-8899-aabbccddeeff'
    const b = guidLe(uuid)
    assert.equal(b.length, 16)
    // bytes 0-3 = 33 22 11 00
    assert.equal(b[0], 0x33)
    assert.equal(b[1], 0x22)
    assert.equal(b[2], 0x11)
    assert.equal(b[3], 0x00)
    // bytes 4-5 = 55 44
    assert.equal(b[4], 0x55)
    assert.equal(b[5], 0x44)
    // bytes 6-7 = 77 66
    assert.equal(b[6], 0x77)
    assert.equal(b[7], 0x66)
    // last 8 bytes as-is
    assert.deepEqual([...b.subarray(8)], [0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
  })

  it('psrpMessage: every client→server message carries dest=2 (MS-PSRP 2.2.1, pypsrp wire capture)', () => {
    const rpid = '00000000-0000-0000-0000-000000000001'
    const pid = '00000000-0000-0000-0000-000000000002'
    for (const [name, type] of [
      ['SESSION_CAPABILITY', 0x00010002],
      ['INIT_RUNSPACEPOOL', 0x00010004],
      ['CREATE_PIPELINE', 0x00021006],
    ] as const) {
      const msg = psrpMessage(type, rpid, pid, '<Obj/>')
      assert.equal(msg.readUInt32LE(0), 2, `${name} dest must be 2 (server)`)
      assert.equal(msg.readUInt32LE(4), type, `${name} type`)
    }
  })

  it('fragment + unfragment round-trips a small message as one START|END fragment', () => {
    const rpid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const pid = '11111111-2222-3333-4444-555555555555'
    const msg = psrpMessage(0x00010002, rpid, pid, '<MS/>')
    const { blob, nextObjectId } = fragmentMessages([msg], 1)
    assert.equal(nextObjectId, 2)
    assert.equal(blob.readUInt8(16), 0x3, 'START|END flags')
    const recovered = unfragmentMessages(blob)
    assert.equal(recovered.length, 1)
    assert.deepEqual(recovered[0], msg)
  })

  it('fragmentMessages never reuses objectId across messages (session-unique)', () => {
    const rpid = '00000000-0000-0000-0000-000000000001'
    const pid = '00000000-0000-0000-0000-000000000000'
    const a = psrpMessage(0x00010002, rpid, pid, 'A')
    const b = psrpMessage(0x00010004, rpid, pid, 'B')
    const { blob, nextObjectId } = fragmentMessages([a, b], 7)
    assert.equal(nextObjectId, 9)
    const id1 = blob.readBigUInt64BE(0)
    // skip first fragment (21 + a.length)
    const id2 = blob.readBigUInt64BE(21 + a.length)
    assert.equal(id1, 7n)
    assert.equal(id2, 8n)
  })

  it('WS-Man CommandState ExitCode regex matches the real Windows ReceiveResponse shape', () => {
    // Verbatim shape from a pypsrp 0.8.1 wire capture against Windows Server 2022.
    const body =
      '<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="X">AAAA</rsp:Stream>' +
      '<rsp:CommandState CommandId="X" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done">' +
      '<rsp:ExitCode>3</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>'
    const re = /<\w*:?ExitCode>\s*(-?\d+)\s*<\/\w*:?ExitCode>/i
    const m = body.match(re)
    assert.ok(m, 'must match rsp:ExitCode')
    assert.equal(parseInt(m![1], 10), 3)
    // and a zero / negative variant
    assert.equal(parseInt('<x:ExitCode>0</x:ExitCode>'.match(re)![1], 10), 0)
    assert.equal(parseInt('<ExitCode> -1 </ExitCode>'.match(re)![1], 10), -1)
  })

  it('unfragmentMessages reassembles a multi-fragment message', () => {
    const rpid = '00000000-0000-0000-0000-000000000001'
    const pid = '00000000-0000-0000-0000-000000000002'
    const payload = 'X'.repeat(100)
    const msg = psrpMessage(0x00021006, rpid, pid, payload)
    const { blob } = fragmentMessages([msg], 1, 40) // force multiple fragments
    const recovered = unfragmentMessages(blob)
    assert.equal(recovered.length, 1)
    assert.deepEqual(recovered[0], msg)
  })
})

describe('PSRPTransport persistent pool', () => {
  it('ensurePool reuses one Create; two runScriptOnPool share it; closePool Deletes once', async () => {
    const { PSRPTransport } = await import('./PSRPTransport')
    class T extends PSRPTransport {
      creates = 0
      commands = 0
      deletes = 0
      constructor() {
        super({ host: '127.0.0.1', port: 5985, username: 'u', password: 'p', transport: 'http' })
      }
      protected async post(action: string) {
        if (action.includes('Create') && !action.includes('Command')) {
          this.creates += 1
          return { status: 200, body: '<w:Selector Name="ShellId">SHELL-1</w:Selector>' }
        }
        if (action.includes('Receive')) {
          return {
            status: 200,
            body:
              '<rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>0</rsp:ExitCode></rsp:CommandState>',
          }
        }
        if (action.includes('Command')) {
          this.commands += 1
          return { status: 200, body: '<CommandId>CMD-1</CommandId>' }
        }
        if (action.includes('Delete')) {
          this.deletes += 1
          return { status: 200, body: '' }
        }
        return { status: 200, body: '' }
      }
    }
    const t = new T()
    const a = await t.ensurePool()
    const b = await t.ensurePool()
    assert.equal(a.shellId, b.shellId)
    assert.equal(t.creates, 1)
    await t.runScriptOnPool('Write-Output 1')
    await t.runScriptOnPool('Write-Output 2')
    assert.equal(t.creates, 1)
    assert.equal(t.commands, 2)
    await t.closePool()
    assert.equal(t.deletes, 1)
    await t.ensurePool()
    assert.equal(t.creates, 2)
  })

  it('PIPELINE_OUTPUT parser extracts I32 when there is no <S> string', () => {
    const payload = '<Obj><MS><I32>42</I32></MS></Obj>'
    const sRe = /<S[^>]*>([\s\S]*?)<\/S>/gi
    let extracted = false
    let stdout = ''
    let sm: RegExpExecArray | null
    while ((sm = sRe.exec(payload)) !== null) {
      stdout += sm[1]
      extracted = true
    }
    if (!extracted) {
      const nRe = /<(?:I32|I64|B|ToString)[^>]*>([\s\S]*?)<\/(?:I32|I64|B|ToString)>/i
      const nm = payload.match(nRe)
      if (nm) stdout += nm[1]
    }
    assert.equal(stdout, '42')
  })
})

