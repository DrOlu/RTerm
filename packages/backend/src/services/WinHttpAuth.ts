/**
 * HTTP client for WinRM / PSRP with Basic, NTLMv2, and Negotiate.
 *
 * NTLM is connection-oriented: Type 3 MUST reuse the TCP connection that
 * received Type 2. We therefore always use a keep-alive Agent with maxSockets=1
 * for ntlm/negotiate.
 *
 * Kerberos (true GSSAPI SPNEGO) is attempted when `auth: 'kerberos'` AND the
 * optional `kerberos` npm package is resolvable (typically after
 * `kinit user@REALM`). If it isn't, we fall through to NTLMv2 under the
 * Negotiate scheme — which is what Windows workgroup hosts speak anyway.
 */
import http from 'node:http'
import https from 'node:https'
import {
  createType1,
  createType3,
  fromBase64,
  parseType2,
  parseUsername,
  toBase64,
} from './ntlm'

export type WinHttpAuthKind = 'basic' | 'ntlm' | 'negotiate' | 'kerberos'

export interface WinHttpAuthOptions {
  host: string
  port: number
  username: string
  password: string
  domain?: string
  transport: 'http' | 'https'
  path?: string
  rejectUnauthorized?: boolean
  timeoutMs?: number
  auth?: WinHttpAuthKind
}

export interface WinHttpResponse {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function wwwAuth(headers: http.IncomingHttpHeaders): string {
  const raw = headers['www-authenticate']
  if (!raw) return ''
  return Array.isArray(raw) ? raw.join(', ') : raw
}

function extractSchemeToken(header: string, scheme: 'NTLM' | 'Negotiate'): string | null {
  const re = new RegExp(`${scheme}\\s+([A-Za-z0-9+/=]+)`, 'i')
  const m = header.match(re)
  return m ? m[1] : null
}

export class WinHttpAuth {
  private readonly opts: Required<Omit<WinHttpAuthOptions, 'rejectUnauthorized' | 'domain' | 'auth'>> &
    Pick<WinHttpAuthOptions, 'rejectUnauthorized' | 'domain' | 'auth'>
  private readonly agent: http.Agent | https.Agent
  private readonly parsed: { user: string; domain: string }

  constructor(opts: WinHttpAuthOptions) {
    this.opts = {
      ...opts,
      path: opts.path ?? '/wsman',
      timeoutMs: opts.timeoutMs ?? 30000,
      rejectUnauthorized: opts.rejectUnauthorized,
      domain: opts.domain,
      auth: opts.auth ?? 'basic',
    } as any
    this.parsed = parseUsername(opts.username, opts.domain)
    this.agent =
      opts.transport === 'https'
        ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: opts.rejectUnauthorized ?? true })
        : new http.Agent({ keepAlive: true, maxSockets: 1 })
  }

  endpoint(): string {
    return `${this.opts.transport}://${this.opts.host}:${this.opts.port}${this.opts.path}`
  }

  authKind(): WinHttpAuthKind {
    return this.opts.auth ?? 'basic'
  }

  async post(body: string, extraHeaders?: Record<string, string>): Promise<WinHttpResponse> {
    const kind = this.opts.auth ?? 'basic'
    if (kind === 'basic') return this.postBasic(body, extraHeaders)
    if (kind === 'kerberos') {
      const gss = await this.tryKerberos(body, extraHeaders)
      if (gss) return gss
      // Fall through to NTLM under Negotiate — workgroup hosts have no KDC.
    }
    // Windows WinRM advertises `Negotiate` (and Basic), not a bare `NTLM`
    // scheme — so auth:'ntlm' still speaks NTLMv2, but under Negotiate on
    // the wire. A server that only offers NTLM is handled by postNtlm's
    // scheme fallback.
    return this.postNtlm(body, extraHeaders, 'Negotiate')
  }

  private postOnce(
    headers: Record<string, string>,
    body: string,
  ): Promise<WinHttpResponse> {
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
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        Connection: 'keep-alive',
        ...headers,
      },
      // @ts-expect-error rejectUnauthorized is https-only
      rejectUnauthorized: isHttps ? this.opts.rejectUnauthorized ?? true : undefined,
      timeout: this.opts.timeoutMs,
      agent: this.agent,
    }
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          })
        })
        res.on('error', reject)
      })
      req.on('timeout', () =>
        req.destroy(new Error(`WinRM request timed out after ${this.opts.timeoutMs}ms`)),
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private async postBasic(body: string, extraHeaders?: Record<string, string>): Promise<WinHttpResponse> {
    const user = this.opts.domain ? `${this.opts.domain}\\${this.parsed.user}` : this.opts.username
    const header = 'Basic ' + Buffer.from(`${user}:${this.opts.password}`, 'utf8').toString('base64')
    return this.postOnce({ Authorization: header, ...extraHeaders }, body)
  }

  /**
   * Three-legged NTLM/Negotiate handshake on one keep-alive socket:
   *   POST (no auth) → 401 + Type 2  OR  POST Type 1 → 401 + Type 2
   *   POST Type 3 + body → 200
   * We send Type 1 first (empty body) so the server issues Type 2 without
   * us having to guess whether it wants a probe or a Type 1.
   */
  private async postNtlm(
    body: string,
    extraHeaders: Record<string, string> | undefined,
    scheme: 'NTLM' | 'Negotiate',
  ): Promise<WinHttpResponse> {
    const type1 = createType1(this.parsed.domain)
    const first = await this.postOnce(
      { Authorization: `${scheme} ${toBase64(type1)}`, ...extraHeaders },
      '',
    )
    if (first.status !== 401) {
      // Some stacks accept Type 1 as enough; treat a 2xx as success (empty
      // body though — caller will retry with the real payload? Unlikely.)
      if (first.status >= 200 && first.status < 300 && first.body) return first
      throw new Error(
        `NTLM/Negotiate Type 1 expected HTTP 401, got ${first.status}: ${first.body.slice(0, 200)}`,
      )
    }
    const header = wwwAuth(first.headers)
    const token =
      extractSchemeToken(header, scheme) ||
      extractSchemeToken(header, 'Negotiate') ||
      extractSchemeToken(header, 'NTLM')
    if (!token) {
      throw new Error(
        `NTLM/Negotiate Type 2 missing from WWW-Authenticate: ${header || '(none)'}`,
      )
    }
    const type2 = parseType2(fromBase64(token))
    const type3 = createType3(type2, {
      username: this.parsed.user,
      password: this.opts.password,
      domain: this.parsed.domain || type2.targetName,
    })
    return this.postOnce(
      { Authorization: `${scheme} ${toBase64(type3)}`, ...extraHeaders },
      body,
    )
  }

  /** Optional GSSAPI Kerberos via the `kerberos` npm package. Returns null if unavailable. */
  private async tryKerberos(
    body: string,
    extraHeaders?: Record<string, string>,
  ): Promise<WinHttpResponse | null> {
    let kerberos: any
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      kerberos = require('kerberos')
    } catch {
      return null
    }
    const spn = `HTTP/${this.opts.host}`
    try {
      const client = await new Promise<any>((resolve, reject) => {
        kerberos.initializeClient(spn, { mechOID: kerberos.GSS_MECH_OID_KRB5 }, (err: Error, c: any) => {
          if (err) reject(err)
          else resolve(c)
        })
      })
      const token: string = await new Promise((resolve, reject) => {
        client.step('', (err: Error, t: string) => {
          if (err) reject(err)
          else resolve(t)
        })
      })
      return this.postOnce(
        { Authorization: `Negotiate ${token}`, ...extraHeaders },
        body,
      )
    } catch {
      return null
    }
  }
}
