import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { WinHttpAuth, type WinHttpAuthKind } from './WinHttpAuth'

/**
 * PSRP (PowerShell Remoting Protocol) transport — dependency-free, rides on
 * the same WS-Management SOAP channel as WinRMTransport (port 5985/5986).
 *
 * Why PSRP: the script travels INSIDE the PSRP message body, so the WinRM
 * command-line budget (8191 chars for `powershell -EncodedCommand …`) does
 * not apply. Also: a real PowerShell runspace (structured error records)
 * instead of cmd.exe text scraping.
 *
 * Wire format (MS-PSRP 2.5 over WS-Man; byte-verified against pypsrp 0.8.1):
 *
 *  PSRP MESSAGE (2.2.1):
 *    destination UInt32LE (1 = client runspace-pool msgs, 2 = pipeline msgs)
 *    messageType UInt32LE (0x00010002 SESSION_CAPABILITY, 0x00010004
 *      INIT_RUNSPACEPOOL, 0x00021006 CREATE_PIPELINE, 0x00041004
 *      PIPELINE_OUTPUT, 0x00041005 ERROR_RECORD, 0x00041006 PIPELINE_STATE)
 *    rpid  16 bytes — RunspacePool id GUID (.NET little-endian layout)
 *    pid   16 bytes — Pipeline id GUID (.NET little-endian layout)
 *    payload     — CLIXML/UTF-8 XML (may start with a UTF-8 BOM)
 *
 *  FRAGMENT (2.2.4.1) — what goes inside <creationXml> / <Arguments>:
 *    objectId  UInt64BE (1, 2, … — one per PSRP message)
 *    fragmentId UInt64BE (sequence within the message, 0-based)
 *    startEnd  UInt8   (bit0 START, bit1 END)
 *    length    UInt32BE (byte length of fragment data)
 *    data
 *  A message smaller than the envelope budget is ONE fragment (START|END).
 *
 *  SESSION FLOW (verified against pypsrp):
 *    1. WS-Man Create, resource URI …/powershell/Microsoft.PowerShell,
 *       OptionSet protocolversion=2.3 (mustUnderstand), <creationXml> =
 *       base64(fragments of [SESSION_CAPABILITY(dest=1),
 *       INIT_RUNSPACEPOOL(dest=1)]) → ShellId (also returned in a SelectorSet)
 *    2. WS-Man Command: <rsp:CommandLine CommandId=PIPELINE_ID><rsp:Command/>
 *       <rsp:Arguments>base64(fragment(CREATE_PIPELINE, dest=2))</Arguments>
 *       with OptionSet WINRS_SKIP_CMD_SHELL=false → CommandId
 *    3. WS-Man Receive loop with OptionSet
 *       WSMAN_CMDSHELL_OPTION_KEEPALIVE=true: stdout Stream elements carry
 *       base64 fragments; messages are PIPELINE_OUTPUT (<S> text),
 *       ERROR_RECORD, PIPELINE_STATE (done + exit code)
 *    4. WS-Man Delete.
 *
 * Auth: Basic over WS-Man (same as WinRMTransport). NTLM/Kerberos are NOT
 * implemented — Basic is the lab/non-domain path (identical scope).
 *
 * LIVE-VERIFIED (AWS Windows Server 2022 / PS 5.1 / 5985 Basic, 2026-09-06):
 *   Create → Receive(init, RunspaceState=2) → Command → Receive(stdout) →
 *   Delete, end to end. `$env:COMPUTERNAME` returns the hostname; a 12 000-
 *   char script (well over the WinRM 8191-char command-line budget) runs
 *   with exit 0 and full output. Wire format was validated byte-for-byte
 *   against a pypsrp 0.8.1 capture — see the two root causes below.
 *
 * Two bugs that made Receive return `w:InvalidSelectors` after a successful
 * Create (both invisible at Create time — Windows accepts the shell, then
 * the PSRP plugin fails runspace init and the ShellId is never bound):
 *   1. Message Destination byte. MS-PSRP 2.2.1 defines it as WHO RECEIVES
 *      (1 = client, 2 = server), not "pool vs pipeline". Every client → server
 *      message is dest=2. We were sending dest=1 for SESSION_CAPABILITY and
 *      INIT_RUNSPACEPOOL.
 *   2. INIT_RUNSPACEPOOL payload. PSThreadOptions / ApartmentState / HostInfo
 *      must be full serialized objects (enum TN + ToString + I32; HostInfo
 *      with the four _isHost*Null booleans). `<Nil/>` is accepted on the wire
 *      but the runspace never opens.
 *
 * Protocol encode/decode is covered by PSRPTransport.extreme.spec.ts.
 * Default WinRM (cmd-shell) path is unchanged; PSRP is opt-in via
 * `transport: 'psrp'` on a WinRM connection.
 */

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  w: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
  rsp: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell',
  n: 'http://schemas.xmlsoap.org/ws/2004/09/enumeration',
}

/** PSRP resource URI — a PowerShell runspace pool, not a cmd shell. */
export const PSRP_SHELL_URI = 'http://schemas.microsoft.com/powershell/Microsoft.PowerShell'

const MSG = {
  SESSION_CAPABILITY: 0x00010002,
  INIT_RUNSPACEPOOL: 0x00010004,
  CREATE_PIPELINE: 0x00021006,
  RUNSPACEPOOL_STATE: 0x00021005,
  APPLICATION_PRIVATE_DATA: 0x0002100A,
  PIPELINE_OUTPUT: 0x00041004,
  ERROR_RECORD: 0x00041005,
  PIPELINE_STATE: 0x00041006,
} as const

export interface PSRPTransportOptions {
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
  /** Auth scheme. Default 'basic'. Same as WinRMTransport. */
  auth?: WinHttpAuthKind
  domain?: string
}

export interface PSRPCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  /** True when the script raised PowerShell errors (ps.had_errors equivalent). */
  hadErrors: boolean
}

interface SoapResponse {
  status: number
  body: string
}

// ── PSRP message + fragment layer ───────────────────────────────────────────

/** GUID in .NET little-endian byte order (MS-PSRP rpid/pid on the wire). */
export function guidLe(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  const b = Buffer.from(hex, 'hex')
  const out = Buffer.alloc(16)
  // .NET Guid layout: first 3 fields little-endian, last 2 as-is
  out[0] = b[3]; out[1] = b[2]; out[2] = b[1]; out[3] = b[0]
  out[4] = b[5]; out[5] = b[4]
  out[6] = b[7]; out[7] = b[6]
  b.subarray(8).copy(out, 8)
  return out
}

/** Build one PSRP message: destination + type + rpid + pid + payload. */
export function psrpMessage(messageType: number, rpid: string, pid: string, payload: string): Buffer {
  const dest = Buffer.alloc(4)
  // MS-PSRP 2.2.1: Destination is WHO RECEIVES the message — 1 = client,
  // 2 = server. Every message the client sends is dest=2, regardless of
  // whether it targets the runspace pool or a pipeline. (Confirmed against
  // a pypsrp 0.8.1 wire capture: SESSION_CAPABILITY, INIT_RUNSPACEPOOL and
  // CREATE_PIPELINE all carry dest=2.) Using 1 here made Windows treat the
  // creationXml as malformed → shell created but InvalidSelectors on Receive.
  dest.writeUInt32LE(2, 0)
  const type = Buffer.alloc(4)
  type.writeUInt32LE(messageType, 0)
  const body = Buffer.from(payload, 'utf8')
  return Buffer.concat([dest, type, guidLe(rpid), guidLe(pid), body])
}

/**
 * Fragment PSRP messages into WS-Man-sized fragments (concatenated).
 * objectId is SESSION-UNIQUE (the server tracks fragment state per objectId),
 * so the counter lives on the transport and never resets — mirrors pypsrp's
 * outgoing_counter. fragmentId counts pieces within one message.
 */
export function fragmentMessages(messages: Buffer[], objectIdStart: number, maxPayload = 0x8000): { blob: Buffer; nextObjectId: number } {
  const out: Buffer[] = []
  let objectId = objectIdStart
  for (const msg of messages) {
    const maxChunk = maxPayload - 21
    let fragmentId = 0
    let offset = 0
    let start = true
    for (;;) {
      const chunk = msg.subarray(offset, offset + maxChunk)
      offset += chunk.length
      const end = offset >= msg.length
      const head = Buffer.alloc(21)
      head.writeBigUInt64BE(BigInt(objectId), 0)
      head.writeBigUInt64BE(BigInt(fragmentId), 8)
      head.writeUInt8((start ? 0x1 : 0) | (end ? 0x2 : 0), 16)
      head.writeUInt32BE(chunk.length, 17)
      out.push(head, chunk)
      fragmentId += 1
      start = false
      if (end) break
    }
    objectId += 1
  }
  return { blob: Buffer.concat(out), nextObjectId: objectId }
}

/** Decode concatenated fragments into complete message payloads (raw bytes). */
export function unfragmentMessages(data: Buffer): Buffer[] {
  const messages: Buffer[] = []
  let i = 0
  let current: Buffer[] = []
  let currentId = -1n
  while (i + 21 <= data.length) {
    const objectId = data.readBigUInt64BE(i)
    const startEnd = data.readUInt8(i + 16)
    const len = data.readUInt32BE(i + 17)
    const chunk = data.subarray(i + 21, i + 21 + len)
    i += 21 + len
    if (currentId !== objectId) {
      if (current.length) messages.push(Buffer.concat(current))
      current = []
      currentId = objectId
    }
    current.push(chunk)
    if (startEnd & 0x2) {
      messages.push(Buffer.concat(current))
      current = []
      currentId = -1n
    }
  }
  if (current.length) messages.push(Buffer.concat(current))
  return messages
}

// ── PSRP payload builders (CLIXML) ──────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** SESSION_CAPABILITY payload (MS-PSRP 2.2.2.1). */
function sessionCapabilityXml(): string {
  return (
    `<Obj RefId="0"><MS>` +
    `<Version N="protocolversion">2.3</Version>` +
    `<Version N="PSVersion">2.0</Version>` +
    `<Version N="SerializationVersion">1.1.0.1</Version>` +
    `</MS></Obj>`
  )
}

/** INIT_RUNSPACEPOOL payload (MS-PSRP 2.2.2.2). */
function initRunspacePoolXml(): string {
  // Byte-for-byte the payload pypsrp 0.8.1 sends (decoded from a live wire
  // capture). Windows accepts Nil for the enum/host fields at Create time but
  // then fails the runspace init silently → InvalidSelectors on Receive.
  return (
    `<Obj RefId="0"><MS>` +
    `<I32 N="MinRunspaces">1</I32>` +
    `<I32 N="MaxRunspaces">1</I32>` +
    `<Obj RefId="1" N="PSThreadOptions">` +
    `<TN RefId="0"><T>System.Management.Automation.Runspaces.PSThreadOptions</T><T>System.Enum</T><T>System.ValueType</T><T>System.Object</T></TN>` +
    `<ToString>Default</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="2" N="ApartmentState">` +
    `<TN RefId="1"><T>System.Management.Automation.Runspaces.ApartmentState</T><T>System.Enum</T><T>System.ValueType</T><T>System.Object</T></TN>` +
    `<ToString>UNKNOWN</ToString><I32>2</I32></Obj>` +
    `<Obj RefId="3" N="HostInfo"><MS>` +
    `<B N="_isHostNull">true</B><B N="_isHostUINull">true</B>` +
    `<B N="_isHostRawUINull">true</B><B N="_useRunspaceHost">true</B>` +
    `</MS></Obj>` +
    `<Nil N="ApplicationArguments" />` +
    `</MS></Obj>`
  )
}

/**
 * CREATE_PIPELINE payload (MS-PSRP 2.2.2.10) — the script runs as the
 * pipeline's single script command. Byte-shape mirrors pypsrp's serializer.
 */
function createPipelineXml(script: string): string {
  return (
    `<Obj RefId="0"><MS>` +
    `<B N="NoInput">true</B>` +
    `<Obj RefId="1" N="ApartmentState"><TN RefId="0"><T>System.Management.Automation.Runspaces.ApartmentState</T><T>System.Enum</T><T>System.ValueType</T><T>System.Object</T></TN><ToString>UNKNOWN</ToString><I32>2</I32></Obj>` +
    `<Obj RefId="2" N="RemoteStreamOptions"><TN RefId="1"><T>System.Management.Automation.Runspaces.RemoteStreamOptions</T><T>System.Enum</T><T>System.ValueType</T><T>System.Object</T></TN><ToString>AddInvocationInfoToErrorRecord</ToString><I32>1</I32></Obj>` +
    `<B N="AddToHistory">false</B>` +
    `<Obj RefId="3" N="HostInfo"><MS><B N="_isHostNull">true</B><B N="_isHostUINull">true</B><B N="_isHostRawUINull">true</B><B N="_useRunspaceHost">true</B></MS></Obj>` +
    `<Obj RefId="4" N="PowerShell"><MS>` +
    `<B N="IsNested">false</B>` +
    `<Nil N="ExtraCmds" />` +
    `<Obj RefId="5" N="Cmds"><TN RefId="2"><T>System.Collections.Generic.List\`1[[System.Management.Automation.PSObject, System.Management.Automation, Version=1.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35]]</T><T>System.Object</T></TN><LST>` +
    `<Obj RefId="6"><MS>` +
    `<S N="Cmd">${escapeXml(script)}</S>` +
    `<B N="IsScript">true</B>` +
    `<Nil N="UseLocalScope" />` +
    `<Obj RefId="7" N="MergeMyResult"><TN RefId="3"><T>System.Management.Automation.Runspaces.PipelineResultTypes</T><T>System.Enum</T><T>System.ValueType</T><T>System.Object</T></TN><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="8" N="MergeToResult"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="9" N="MergePreviousResults"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="10" N="Args"><TNRef RefId="2" /><LST /></Obj>` +
    `<Obj RefId="11" N="MergeError"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="12" N="MergeWarning"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="13" N="MergeVerbose"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="14" N="MergeDebug"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `<Obj RefId="15" N="MergeInformation"><TNRef RefId="3" /><ToString>None</ToString><I32>0</I32></Obj>` +
    `</MS></Obj>` +
    `</LST></Obj>` +
    `<S N="History" />` +
    `<B N="RedirectShellErrorOutputPipe">false</B>` +
    `</MS></Obj>` +
    `<B N="IsNested">false</B>` +
    `</MS></Obj>`
  )
}

function firstText(xml: string, localName: string): string {
  const re = new RegExp(`<\\w*:?${localName}\\b[^>]*>([\\s\\S]*?)<\\/\\w*:?${localName}>`, 'i')
  const m = xml.match(re)
  return m ? m[1] : ''
}

function extractShellId(xml: string): string {
  const re = /<\w*:?Selector\b[^>]*\bName="ShellId"[^>]*>([\s\S]*?)<\/\w*:?Selector>/i
  const m = xml.match(re)
  if (m) return m[1].trim()
  return ''
}

export class PSRPTransport {
  /** pypsrp WSMan.session_id — one uuid for the life of the transport. */
  private readonly sessionId = `uuid:${randomUUID().toUpperCase()}`
  private readonly http: WinHttpAuth

  constructor(opts: PSRPTransportOptions) {
    this.http = new WinHttpAuth({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      domain: opts.domain,
      transport: opts.transport,
      path: opts.path,
      rejectUnauthorized: opts.rejectUnauthorized,
      timeoutMs: opts.timeoutMs,
      auth: opts.auth ?? 'basic',
    })
  }

  private endpoint(): string {
    return this.http.endpoint()
  }

  private envelope(action: string, body: string, extraHeaders: string): string {
    const mid = `uuid:${randomUUID()}`
    const to = this.endpoint()
    // Header order matches pypsrp WSMan._create_header exactly:
    // Action, DataLocale, Locale, MaxEnvelopeSize, MessageID, OperationTimeout,
    // ReplyTo, ResourceURI, SessionId, To, then OptionSet/SelectorSet.
    // Prefixes match pypsrp 0.8.1 exactly (wsa/wsman/wsmv). Windows' PSRP
    // plugin is prefix-sensitive for wsmv:SessionId — using xmlns:p for the
    // Microsoft wsman URI made Receive after Create return InvalidSelectors.
    const wsmv = 'http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd'
    return `<s:Envelope xmlns:s="${NS.s}" xmlns:wsa="${NS.a}" xmlns:wsman="${NS.w}" xmlns:wsmv="${wsmv}" xmlns:rsp="${NS.rsp}" xml:lang="en-US"><s:Header><wsa:Action s:mustUnderstand="true">${action}</wsa:Action><wsmv:DataLocale s:mustUnderstand="false" xml:lang="en-US" /><wsman:Locale s:mustUnderstand="false" xml:lang="en-US" /><wsman:MaxEnvelopeSize s:mustUnderstand="true">512000</wsman:MaxEnvelopeSize><wsa:MessageID>${mid}</wsa:MessageID><wsman:OperationTimeout>PT60.000S</wsman:OperationTimeout><wsa:ReplyTo><wsa:Address s:mustUnderstand="true">${NS.a}/role/anonymous</wsa:Address></wsa:ReplyTo><wsman:ResourceURI s:mustUnderstand="true">${PSRP_SHELL_URI}</wsman:ResourceURI><wsmv:SessionId s:mustUnderstand="false">${this.sessionId}</wsmv:SessionId><wsa:To>${to}</wsa:To>${extraHeaders}</s:Header><s:Body>${body}</s:Body></s:Envelope>`
  }

  private async post(action: string, body: string, extraHeaders: string): Promise<SoapResponse> {
    const envelope = this.envelope(action, body, extraHeaders)
    const res = await this.http.post(envelope)
    return { status: res.status, body: res.body }
  }

  /**
   * Run a PowerShell script end-to-end over PSRP:
   *   Create (creationXml = SESSION_CAPABILITY + INIT_RUNSPACEPOOL) →
   *   Command (CommandLine CommandId=PIPELINE_ID, empty Command, fragment in
   *   Arguments carrying CREATE_PIPELINE dest=2) →
   *   Receive loop (PIPELINE_OUTPUT / ERROR_RECORD / PIPELINE_STATE) → Delete.
   * The script travels inside the PSRP message body — no command-line length limit.
   */
  async runScript(
    script: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PSRPCommandResult> {
    const deadline = Date.now() + (opts?.timeoutMs ?? 120000)
    const rpid = randomUUID().toUpperCase()
    const pipelineId = randomUUID().toUpperCase()

    // 1. Create the PSRP shell with the runspace-pool creation fragment.
    const creation = fragmentMessages([
      psrpMessage(MSG.SESSION_CAPABILITY, rpid, '00000000-0000-0000-0000-000000000000', sessionCapabilityXml()),
      psrpMessage(MSG.INIT_RUNSPACEPOOL, rpid, '00000000-0000-0000-0000-000000000000', initRunspacePoolXml()),
    ], 1)
    const creationFragment = creation.blob
    const createBody =
      `<rsp:Shell ShellId="${rpid}">` +
      `<rsp:InputStreams>stdin pr</rsp:InputStreams>` +
      `<rsp:OutputStreams>stdout</rsp:OutputStreams>` +
      `<creationXml xmlns="http://schemas.microsoft.com/powershell">` +
      creationFragment.toString('base64') +
      `</creationXml>` +
      `</rsp:Shell>`
    const createHeaders =
      `<wsman:OptionSet s:mustUnderstand="true">` +
      `<wsman:Option MustComply="true" Name="protocolversion">2.3</wsman:Option>` +
      `</wsman:OptionSet>`
    const created = await this.post(
      'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
      createBody,
      createHeaders,
    )
    this.assertOk(created, 'Create')
    const shellId = extractShellId(created.body)
    if (!shellId) throw new Error('PSRP Create succeeded but no ShellId returned.')

    try {
      // 1b. Receive until the runspace pool is Opened (state=2). Sending
      // Command before this Receive is why Windows returns InvalidSelectors —
      // the shell exists but the PSRP plugin has not finished init.
      await this.waitForRunspaceOpened(shellId, deadline, opts?.signal)

      // 2. Command: CommandLine carries the PIPELINE id, empty Command, and the
      //    CREATE_PIPELINE fragment (dest=2) in Arguments.
      //    Header order matters for the PSRP plugin: OptionSet BEFORE SelectorSet.
      const createPipelineMsg = psrpMessage(MSG.CREATE_PIPELINE, rpid, pipelineId, createPipelineXml(script))
      const commandBody =
        `<rsp:CommandLine CommandId="${pipelineId}">` +
        `<rsp:Command></rsp:Command>` +
        `<rsp:Arguments>${fragmentMessages([createPipelineMsg], creation.nextObjectId).blob.toString('base64')}</rsp:Arguments>` +
        `</rsp:CommandLine>`
      const commandHeaders =
        `<wsman:OptionSet s:mustUnderstand="true">` +
        `<wsman:Option Name="WINRS_SKIP_CMD_SHELL">False</wsman:Option>` +
        `</wsman:OptionSet>` +
        this.shellHeaders(shellId)
      const commanded = await this.post(
        'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
        commandBody,
        commandHeaders,
      )
      this.assertOk(commanded, 'Command')
      const commandId = firstText(commanded.body, 'CommandId')
      if (!commandId) throw new Error('PSRP Command succeeded but no CommandId returned.')

      // 3. Receive loop until PIPELINE_STATE says the pipeline is done.
      let stdout = ''
      let stderr = ''
      let hadErrors = false
      let exitCode = 0
      let pipelineDone = false
      for (;;) {
        if (opts?.signal?.aborted) throw new Error('AbortError')
        if (Date.now() > deadline) {
          throw new Error(`PSRP command timed out after ${opts?.timeoutMs ?? 120000}ms`)
        }
        const receiveBody =
          `<rsp:Receive><rsp:DesiredStream CommandId="${commandId}">stdout</rsp:DesiredStream></rsp:Receive>`
        const receiveHeaders =
          `<wsman:OptionSet s:mustUnderstand="true"><wsman:Option Name="WSMAN_CMDSHELL_OPTION_KEEPALIVE">True</wsman:Option></wsman:OptionSet>` +
          this.shellHeaders(shellId)
        const received = await this.post(
          'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
          receiveBody,
          receiveHeaders,
        )
        this.assertOk(received, 'Receive')
        const streamRe = /<\w*:?Stream\b[^>]*\bName="(?:stdout|stderr|pr)"[^>]*>([\s\S]*?)<\/\w*:?Stream>/gi
        let m: RegExpExecArray | null
        while ((m = streamRe.exec(received.body)) !== null) {
          const b64 = m[1].replace(/\s+/g, '')
          if (!b64) continue
          for (const raw of unfragmentMessages(Buffer.from(b64, 'base64'))) {
            if (raw.length < 40) continue
            const messageType = raw.readUInt32LE(4)
            const payload = raw.subarray(40).toString('utf8').replace(/^\uFEFF/, '')
            if (messageType === MSG.PIPELINE_OUTPUT) {
              const sRe = /<S[^>]*>([\s\S]*?)<\/S>/gi
              let sm: RegExpExecArray | null
              while ((sm = sRe.exec(payload)) !== null) stdout += sm[1]
            } else if (messageType === MSG.ERROR_RECORD) {
              hadErrors = true
              const mRe = payload.match(/<S N="Message">([\s\S]*?)<\/S>/i)
              stderr += (mRe ? mRe[1] : payload) + '\n'
            } else if (messageType === MSG.PIPELINE_STATE) {
              pipelineDone = true
              const stateMatch = payload.match(/<I32 N="State">(\d+)<\/I32>/i)
              if (stateMatch) {
                // 4 = Completed, 5 = Failed, 6 = Stopped (PSInvocationState)
                if (parseInt(stateMatch[1], 10) === 5) hadErrors = true
              }
              const ec = payload.match(/N="ExitCode"[^>]*>(-?\d+)</i)
              if (ec) exitCode = parseInt(ec[1], 10)
            }
          }
        }
        // The WS-Man CommandState carries an ExitCode, but for a PSRP pipeline
        // Windows reports 0 there even after `exit 3` / a terminating error —
        // the PSRP pipeline does not propagate a process exit code the way
        // the cmd shell does (verified live; pypsrp exposes `had_errors`, not
        // an exit code, for exactly this reason). Read it anyway (it is
        // authoritative for shell-level failures) but treat hadErrors as the
        // primary error signal — see the backend adapter.
        const wsExit = received.body.match(/<\w*:?ExitCode>\s*(-?\d+)\s*<\/\w*:?ExitCode>/i)
        if (wsExit) exitCode = parseInt(wsExit[1], 10)
        if (pipelineDone) break
        if (/CommandState\/Done/i.test(received.body)) break
      }
      if (exitCode !== 0) hadErrors = true
      return { stdout, stderr, exitCode, hadErrors }
    } finally {
      await this.deleteShell(shellId)
    }
  }

  /**
   * Drain Receive until RUNSPACEPOOL_STATE reports Opened (state=2).
   * Must run after Create and before Command.
   */
  private async waitForRunspaceOpened(
    shellId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('AbortError')
      if (Date.now() > deadline) throw new Error('PSRP runspace did not open in time')
  const receiveBody = `<rsp:Receive><rsp:DesiredStream>stdout</rsp:DesiredStream></rsp:Receive>`
  const receiveHeaders =
    `<wsman:OptionSet s:mustUnderstand="true"><wsman:Option Name="WSMAN_CMDSHELL_OPTION_KEEPALIVE">True</wsman:Option></wsman:OptionSet>` +
    this.shellHeaders(shellId)
      const received = await this.post(
        'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
        receiveBody,
        receiveHeaders,
      )
      this.assertOk(received, 'Receive(init)')
      const streamRe = /<\w*:?Stream\b[^>]*>([\s\S]*?)<\/\w*:?Stream>/gi
      let m: RegExpExecArray | null
      while ((m = streamRe.exec(received.body)) !== null) {
        const b64 = m[1].replace(/\s+/g, '')
        if (!b64) continue
        for (const raw of unfragmentMessages(Buffer.from(b64, 'base64'))) {
          if (raw.length < 40) continue
          const messageType = raw.readUInt32LE(4)
          if (messageType === MSG.RUNSPACEPOOL_STATE) {
            const payload = raw.subarray(40).toString('utf8').replace(/^\uFEFF/, '')
            const stateMatch = payload.match(/<I32 N="RunspaceState">(\d+)<\/I32>/i)
              || payload.match(/<I32 N="State">(\d+)<\/I32>/i)
            // PSInvocationState / RunspacePoolState: 2 = Opened
            if (stateMatch && parseInt(stateMatch[1], 10) === 2) return
          }
          if (messageType === MSG.APPLICATION_PRIVATE_DATA) {
            // pypsrp dump: first Receive returns SESSION_CAPABILITY + this;
            // Command is only sent after a SECOND Receive with RunspaceState=2.
            continue
          }
        }
      }
      if (/CommandState\/Done/i.test(received.body)) return
    }
  }

  /** Lightweight connectivity probe: create then immediately delete a PSRP shell. */
  async ping(): Promise<void> {
    const rpid = randomUUID().toUpperCase()
    const creationFragment = fragmentMessages([
      psrpMessage(MSG.SESSION_CAPABILITY, rpid, '00000000-0000-0000-0000-000000000000', sessionCapabilityXml()),
      psrpMessage(MSG.INIT_RUNSPACEPOOL, rpid, '00000000-0000-0000-0000-000000000000', initRunspacePoolXml()),
    ], 1).blob
    const createBody =
      `<rsp:Shell ShellId="${rpid}">` +
      `<rsp:InputStreams>stdin pr</rsp:InputStreams>` +
      `<rsp:OutputStreams>stdout</rsp:OutputStreams>` +
      `<creationXml xmlns="http://schemas.microsoft.com/powershell">` +
      creationFragment.toString('base64') +
      `</creationXml>` +
      `</rsp:Shell>`
    const res = await this.post(
      'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
      createBody,
      `<wsman:OptionSet s:mustUnderstand="true"><wsman:Option MustComply="true" Name="protocolversion">2.3</wsman:Option></wsman:OptionSet>`,
    )
    this.assertOk(res, 'Create')
    const shellId = extractShellId(res.body)
    if (shellId) await this.deleteShell(shellId)
  }

  async deleteShell(shellId: string): Promise<void> {
    try {
      await this.post(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
        '',
        this.shellHeaders(shellId),
      )
    } catch {
      // cleanup is best-effort
    }
  }

  private shellHeaders(shellId: string): string {
    return `<wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>`
  }

  private assertOk(res: SoapResponse, op: string): void {
    if (res.status === 200 || res.status === 201) return
    const reason = firstText(res.body, 'Text') || firstText(res.body, 'Reason')
    const fault = firstText(res.body, 'Subcode') || firstText(res.body, 'Value')
    const detail =
      reason || fault
        ? `${fault ? `(${fault}) ` : ''}${reason}`.trim()
        : res.body.slice(0, 200)
    throw new Error(`PSRP ${op} failed: HTTP ${res.status} — ${detail}`)
  }
}
