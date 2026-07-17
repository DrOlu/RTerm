import http from 'node:http'
import https from 'node:https'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

/**
 * Minimal, dependency-free WS-Management (WinRM) transport for command
 * execution over HTTP (5985) / HTTPS (5986) with Basic auth.
 *
 * Scope is deliberately the stateless command-execution cycle that the RTerm
 * agent tools (exec_command / run_fleet_command / collect_facts /
 * probe_connectivity) need:
 *
 *   1. Create a cmd shell resource  →  returns ShellId
 *   2. Command  (CommandId)
 *   3. Receive  (loop until CommandState/Done, accumulate base64 stdout/stderr)
 *   4. Delete the shell resource    (best-effort cleanup)
 *
 * No interactive PTY, no Signal/Ctrl+C, no streaming stdin — WinRM's shell
 * model is request/response and that is what's genuinely good over WinRM.
 * RTerm's WinRMBackend renders tabs as a command/response log, not a PTY.
 */

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  w: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
  rsp: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell',
  n: 'http://schemas.xmlsoap.org/ws/2004/09/enumeration',
}

const SHELL_URI = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd'

export interface WinRMTransportOptions {
  host: string
  port: number
  username: string
  password: string
  /** 'http' (5985) or 'https' (5986). */
  transport: 'http' | 'https'
  /** Path on the server; almost always '/wsman'. */
  path?: string
  /** For HTTPS with self-signed certs, set false to skip cert verification. */
  rejectUnauthorized?: boolean
  /** Per-request timeout (ms). */
  timeoutMs?: number
}

export interface WinRMCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface SoapResponse {
  status: number
  body: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Extract the text content of the first element matching a simple XPath-like
 * expression `tag` (local name) within `xml`. Returns '' if not found. */
function firstText(xml: string, localName: string): string {
  // Match <prefix:localName ...>text</prefix:localName> or <localName ...>text</localName>
  const re = new RegExp(`<\\w*:?${localName}\\b[^>]*>([\\s\\S]*?)<\\/\\w*:?${localName}>`, 'i')
  const m = xml.match(re)
  return m ? m[1] : ''
}

/** Extract all elements matching a local name (returns their inner XML/text). */
function allElements(xml: string, localName: string): string[] {
  const re = new RegExp(`<\\w*:?${localName}\\b[^>]*>([\\s\\S]*?)<\\/\\w*:?${localName}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

/** Pull the ShellId selector value out of a Create response.
 * The Create response contains:
 *   <w:SelectorSet><w:Selector Name="ShellId">UUID</w:Selector></w:SelectorSet>
 * i.e. the value is the direct text of the Selector whose Name attribute is
 * "ShellId" (not a child <Value> element). */
function extractShellId(xml: string): string {
  const re = /<\w*:?Selector\b[^>]*\bName="ShellId"[^>]*>([\s\S]*?)<\/\w*:?Selector>/i
  const m = xml.match(re)
  if (m) return m[1].trim()
  // Fallback: some servers nest a Value element.
  const selectors = allElements(xml, 'Selector')
  for (const sel of selectors) {
    const name = firstText(sel, 'Name')
    if (name.toLowerCase() === 'shellid') return firstText(sel, 'Value')
  }
  return ''
}

export class WinRMTransport {
  private readonly opts: Required<Omit<WinRMTransportOptions, 'rejectUnauthorized'>> &
    Pick<WinRMTransportOptions, 'rejectUnauthorized'>
  private readonly authHeader: string

  constructor(opts: WinRMTransportOptions) {
    this.opts = {
      path: opts.path ?? '/wsman',
      timeoutMs: opts.timeoutMs ?? 30000,
      rejectUnauthorized: opts.rejectUnauthorized,
      ...opts,
    } as any
    this.authHeader =
      'Basic ' + Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')
  }

  private endpoint(): string {
    return `${this.opts.transport}://${this.opts.host}:${this.opts.port}${this.opts.path}`
  }

  /** Build a full SOAP envelope with the required WS-Addressing + WS-Man headers. */
  private envelope(action: string, body: string, extraHeaders: string): string {
    const mid = `uuid:${randomUUID()}`
    const to = this.endpoint()
    return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:rsp="${NS.rsp}" xmlns:n="${NS.n}">
 <s:Header>
  <a:Action>${action}</a:Action>
  <a:To>${to}</a:To>
  <a:ReplyTo><a:Address>${NS.a}/role/anonymous</a:Address></a:ReplyTo>
  <a:MessageID>${mid}</a:MessageID>
  <w:MaxEnvelopeSize xmlns:w="${NS.w}" mustUnderstand="true">153600</w:MaxEnvelopeSize>
  <w:OperationTimeout>PT60S</w:OperationTimeout>
  ${extraHeaders}
 </s:Header>
 <s:Body>${body}</s:Body>
</s:Envelope>`
  }

  private async post(action: string, body: string, extraHeaders: string): Promise<SoapResponse> {
    const envelope = this.envelope(action, body, extraHeaders)
    const url = new URL(this.endpoint())
    const isHttps = this.opts.transport === 'https'
    const lib = isHttps ? https : http
    const options: http.RequestOptions = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        Authorization: this.authHeader,
        'Content-Length': Buffer.byteLength(envelope, 'utf8'),
      },
      // @ts-expect-error rejectUnauthorized is https-only
      rejectUnauthorized: isHttps ? this.opts.rejectUnauthorized ?? true : undefined,
      timeout: this.opts.timeoutMs,
    }
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error(`WinRM request timed out after ${this.opts.timeoutMs}ms`)))
      req.on('error', reject)
      req.write(envelope)
      req.end()
    })
  }

  /** Create a cmd shell resource; returns the ShellId. */
  async createShell(): Promise<string> {
    const body = `<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`
    const headers = `<w:ResourceURI mustUnderstand="true">${SHELL_URI}</w:ResourceURI>`
    const res = await this.post(
      'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
      body,
      headers,
    )
    this.assertOk(res, 'Create')
    const shellId = extractShellId(res.body)
    if (!shellId) throw new Error('WinRM Create succeeded but no ShellId returned.')
    return shellId
  }

  /** Send a command to an existing shell; returns the CommandId. */
  async sendCommand(shellId: string, command: string): Promise<string> {
    const body = `<rsp:CommandLine><rsp:Command>${escapeXml(command)}</rsp:Command></rsp:CommandLine>`
    const headers = this.shellHeaders(shellId)
    const res = await this.post(
      'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
      body,
      headers,
    )
    this.assertOk(res, 'Command')
    const commandId = firstText(res.body, 'CommandId')
    if (!commandId) throw new Error('WinRM Command succeeded but no CommandId returned.')
    return commandId
  }

  /** One Receive round-trip. Returns decoded stdout/stderr chunks and whether
   * the command is done (with exit code if so). The caller loops until done. */
  async receive(
    shellId: string,
    commandId: string,
  ): Promise<{ stdout: string; stderr: string; done: boolean; exitCode?: number }> {
    // The DesiredStream MUST carry a CommandId attribute so the server knows
    // which command's output to stream back (without it the server returns
    // w:InvalidParameter). Value lists both streams, space-separated.
    const body = `<rsp:Receive><rsp:DesiredStream CommandId="${commandId}">stdout stderr</rsp:DesiredStream></rsp:Receive>`
    const headers = this.shellHeaders(shellId)
    const res = await this.post(
      'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
      body,
      headers,
    )
    this.assertOk(res, 'Receive')
    let stdout = ''
    let stderr = ''
    for (const streamEl of allElements(res.body, 'Stream')) {
      // A Stream element looks like: <rsp:Stream Name="stdout" ...>base64</rsp:Stream>
      const nameMatch = streamEl.match(/Name="([^"]+)"/i)
      // allElements returned the INNER content; re-read attributes from the body.
      void nameMatch
    }
    // Re-scan the full body for Stream elements WITH their Name attribute, since
    // allElements() only returns inner text. Base64-decode each chunk.
    const streamRe = /<\w*:?Stream\b[^>]*\bName="(stdout|stderr)"[^>]*>([\s\S]*?)<\/\w*:?Stream>/gi
    let m: RegExpExecArray | null
    while ((m = streamRe.exec(res.body)) !== null) {
      const name = m[1].toLowerCase()
      const b64 = m[2].replace(/\s+/g, '')
      if (!b64) continue
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      if (name === 'stderr') stderr += decoded
      else stdout += decoded
    }
    // CommandState Done? <rsp:CommandState State=".../CommandState/Done"><rsp:ExitCode>N</rsp:ExitCode></rsp:CommandState>
    const doneMatch = res.body.match(/CommandState\/Done/i)
    let done = false
    let exitCode: number | undefined
    if (doneMatch) {
      done = true
      const ec = firstText(res.body, 'ExitCode')
      exitCode = ec !== '' ? parseInt(ec, 10) : 0
      if (!Number.isFinite(exitCode)) exitCode = 0
    }
    return { stdout, stderr, done, exitCode }
  }

  /** Delete (close) a shell resource. Best-effort; errors are swallowed. */
  async deleteShell(shellId: string): Promise<void> {
    try {
      const headers = this.shellHeaders(shellId)
      const res = await this.post(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
        '',
        headers,
      )
      // 200/204 are fine; ignore faults on cleanup.
      if (res.status >= 400) {
        // not fatal
      }
    } catch {
      // cleanup is best-effort
    }
  }

  /** Run a single command end-to-end: create shell → send → receive-to-done → delete. */
  async runCommand(command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WinRMCommandResult> {
    const deadline = Date.now() + (opts?.timeoutMs ?? 120000)
    const shellId = await this.createShell()
    try {
      const commandId = await this.sendCommand(shellId, command)
      let stdout = ''
      let stderr = ''
      let exitCode = 0
      // Loop Receive until Done or timeout/abort. Some commands emit many chunks.
      for (;;) {
        if (opts?.signal?.aborted) throw new Error('AbortError')
        if (Date.now() > deadline) {
          throw new Error(`WinRM command timed out after ${opts?.timeoutMs ?? 120000}ms`)
        }
        const r = await this.receive(shellId, commandId)
        stdout += r.stdout
        stderr += r.stderr
        if (r.done) {
          exitCode = r.exitCode ?? 0
          break
        }
        // If no output and not done yet, the server may send an empty "keep-alive"
        // Receive; loop again (WS-Man Receive is idempotent until Done).
      }
      return { stdout, stderr, exitCode }
    } finally {
      await this.deleteShell(shellId)
    }
  }

  /** Lightweight connectivity probe: create then immediately delete a shell. */
  async ping(): Promise<void> {
    const shellId = await this.createShell()
    await this.deleteShell(shellId)
  }

  private shellHeaders(shellId: string): string {
    return `<w:ResourceURI mustUnderstand="true">${SHELL_URI}</w:ResourceURI>
  <w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet>`
  }

  private assertOk(res: SoapResponse, op: string): void {
    if (res.status === 200 || res.status === 201) return
    // Try to surface the WS-Man fault reason for a useful error message.
    const reason = firstText(res.body, 'Text') || firstText(res.body, 'Reason')
    const fault = firstText(res.body, 'Subcode') || firstText(res.body, 'Value')
    const detail =
      reason || fault
        ? `${fault ? `(${fault}) ` : ''}${reason}`.trim()
        : res.body.slice(0, 200)
    throw new Error(`WinRM ${op} failed: HTTP ${res.status} — ${detail}`)
  }
}
