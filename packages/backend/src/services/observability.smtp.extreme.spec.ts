import net from 'node:net'
import { sendSmtpMail } from './observability'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function includes(hay: string, needle: string, m = '') { if (!hay.includes(needle)) throw new Error(`${m} expected to include "${needle}" in: ${hay.slice(0, 300)}`) }

/** Spin up a minimal mock SMTP server that speaks the happy-path dialogue and
 * captures every client line. Returns the port + a transcript getter. */
function startMockSmtp(): Promise<{ port: number; transcript: () => string; close: () => Promise<void> }> {
  const lines: string[] = []
  const server = net.createServer((socket) => {
    socket.write('220 mock.example.com ESMTP ready\r\n')
    let inData = false
    let authState: 'none' | 'user' | 'pass' = 'none'
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      lines.push(text)
      const respond = (s: string) => socket.write(s + '\r\n')
      const upper = text.toUpperCase()
      if (inData) {
        // DATA phase: the terminating ".\r\n" ends the message.
        if (text.includes('\r\n.\r\n') || text.trimEnd().endsWith('\n.')) {
          inData = false
          respond('250 2.0.0 Ok: queued as ABC123')
        }
        return
      }
      if (upper.startsWith('EHLO')) respond('250-mock.example.com\r\n250 AUTH LOGIN')
      else if (upper.startsWith('AUTH LOGIN')) { authState = 'user'; respond('334 VXNlcm5hbWU6') }
      else if (authState === 'user') { authState = 'pass'; respond('334 UGFzc3dvcmQ6') }
      else if (authState === 'pass') { authState = 'none'; respond('235 2.7.0 Authentication successful') }
      else if (upper.startsWith('MAIL FROM')) respond('250 2.1.0 Ok')
      else if (upper.startsWith('RCPT TO')) respond('250 2.1.5 Ok')
      else if (upper.startsWith('DATA')) { inData = true; respond('354 End data with <CR><LF>.<CR><LF>') }
      else if (upper.startsWith('QUIT')) { respond('221 2.0.0 Bye'); socket.end() }
      else respond('250 Ok')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        transcript: () => lines.join(''),
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

test('sendSmtpMail drives a full plain-SMTP dialogue and returns 250', async () => {
  const srv = await startMockSmtp()
  try {
    const result = await sendSmtpMail(
      { host: '127.0.0.1', port: srv.port, secure: false },
      { from: 'rterm@example.com', to: ['ops@example.com'], subject: '[CRITICAL] disk full', text: 'disk full on web-01', html: '<b>disk full</b>' },
    )
    includes(result, '250', 'result should report 250')
    const t = srv.transcript()
    includes(t, 'EHLO', 'should send EHLO')
    includes(t, 'MAIL FROM:<rterm@example.com>', 'should send MAIL FROM')
    includes(t, 'RCPT TO:<ops@example.com>', 'should send RCPT TO')
    includes(t, 'DATA', 'should send DATA')
    includes(t, 'Subject: [CRITICAL] disk full', 'should include subject header')
    includes(t, 'disk full on web-01', 'should include text body')
    includes(t, '<b>disk full</b>', 'should include html body')
    includes(t, 'multipart/alternative', 'should build a multipart message')
  } finally {
    await srv.close()
  }
})

test('sendSmtpMail performs AUTH LOGIN when auth is configured', async () => {
  const srv = await startMockSmtp()
  try {
    await sendSmtpMail(
      { host: '127.0.0.1', port: srv.port, secure: false, auth: { user: 'svc', pass: 's3cret' } },
      { from: 'a@b.c', to: ['d@e.f'], subject: 'hi', text: 't', html: '<i>t</i>' },
    )
    const t = srv.transcript()
    includes(t, 'AUTH LOGIN', 'should attempt AUTH LOGIN')
    includes(t, Buffer.from('svc', 'utf8').toString('base64'), 'should send base64 username')
    includes(t, Buffer.from('s3cret', 'utf8').toString('base64'), 'should send base64 password')
  } finally {
    await srv.close()
  }
})

test('sendSmtpMail rejects on a non-250 reply (no silent success)', async () => {
  // Mock that always rejects MAIL FROM.
  const server = net.createServer((socket) => {
    socket.write('220 mock\r\n')
    socket.on('data', (chunk) => {
      const u = chunk.toString('utf8').toUpperCase()
      if (u.startsWith('EHLO')) socket.write('250 mock\r\n')
      else if (u.startsWith('MAIL FROM')) socket.write('550 5.7.1 Relaying denied\r\n')
      else socket.write('250 Ok\r\n')
    })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as net.AddressInfo).port
  try {
    let threw = false
    try {
      await sendSmtpMail({ host: '127.0.0.1', port, secure: false }, { from: 'a@b.c', to: ['d@e.f'], subject: 'x', text: 't', html: '<i>t</i>' })
    } catch (e) {
      threw = true
      ok((e as Error).message.includes('MAIL FROM'), 'error should name the failed step')
    }
    ok(threw, 'sendSmtpMail must throw when the server rejects the envelope')
  } finally {
    await new Promise<void>((res) => server.close(() => res()))
  }
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: unknown) { fail++; console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
