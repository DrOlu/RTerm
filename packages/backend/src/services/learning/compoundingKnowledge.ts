/**
 * Compounding knowledge — deterministic lesson extractors + memory.md append.
 *
 * The agent learns from mistakes without a second LLM call: fingerprints in
 * errors/output map to durable never-do/instead pairs that are appended to
 * memory.md (deduped) and injected on the next run. Knowledge compounds because
 * occurrence counts rise and the same fingerprint is never written twice.
 *
 * Extractors are the testable core. A false positive (extracting a lesson from
 * unrelated text) and a false negative (missing a known failure) are both
 * regressions — the extreme spec locks them.
 */

export interface ExtractedLesson {
  fingerprint: string
  title: string
  body: string
  neverDo: string
  instead: string
  tags: string[]
  extractor: string
}

export interface Extractor {
  name: string
  match: (haystack: string) => ExtractedLesson | null
}

const TRIVIAL_INPUT = /^(1\s*\+\s*1|hello|hi|hey|ok|thanks|ping|pong)\s*[.!?]*$/i

export function isTrivialRun(inputPreview?: string, error?: string): boolean {
  const input = (inputPreview || '').trim()
  if (!input && !error) return true
  if (error && error.trim()) return false
  if (TRIVIAL_INPUT.test(input)) return true
  if (
    input.length > 0 &&
    input.length < 8 &&
    !/[\\/]/.test(input) &&
    !/\b(error|fail|join|install|patch)\b/i.test(input)
  ) {
    return true
  }
  return false
}

function lesson(
  extractor: string,
  fingerprint: string,
  title: string,
  body: string,
  neverDo: string,
  instead: string,
  tags: string[],
): ExtractedLesson {
  return { extractor, fingerprint, title, body, neverDo, instead, tags }
}

export const EXTRACTORS: Extractor[] = [
  {
    name: 'psrp-invalid-selectors',
    match: (h) => {
      if (!/invalidselectors/i.test(h)) return null
      return lesson(
        'psrp-invalid-selectors',
        'psrp.invalid-selectors.dest-and-init',
        'PSRP Receive after Create returns w:InvalidSelectors',
        'Windows accepts Create (ShellId returned) then fails runspace init silently. The SOAP envelope is usually fine — the bug is inside the base64 creationXml PSRP fragments.',
        'Do not tweak SOAP headers / xmlns prefixes / SessionId / OptionSet / keep-alive to "fix" InvalidSelectors after a successful Create.',
        'Decode creationXml: every client-to-server PSRP message Destination byte is 2 (server). INIT_RUNSPACEPOOL must send full PSThreadOptions/ApartmentState/HostInfo objects, not Nil. Byte-compare against a pypsrp 0.8.1 capture.',
        ['psrp', 'winrm'],
      )
    },
  },
  {
    name: 'netuseadd-64',
    match: (h) => {
      const netuse = /netuseadd/i.test(h) && (/64\b/.test(h) || /0x40/i.test(h) || /ipc\$/i.test(h))
      const named = /network name is no longer available/i.test(h) && /add-computer|netlogon|ipc\$|domain join/i.test(h)
      const err64 = /ERROR_NETNAME_DELETED/i.test(h)
      if (!netuse && !named && !err64) return null
      return lesson(
        'netuseadd-64',
        'ad.join.netuseadd-64-use-djoin',
        'Domain join fails at NetUseAdd \\\\DC\\IPC$ (error 64 / 0x40)',
        'DNS, LDAP 389, Kerberos 88 and TCP 445 can all succeed while SMB IPC$/NETLOGON still fails from a workgroup host. Retrying Add-Computer will not fix it.',
        'Do not retry Add-Computer after NetUseAdd 64 / "network name is no longer available". Do not keep flipping SMB signing as the next fix.',
        'Use offline domain join: djoin /provision on the DC, copy the blob without SMB, djoin /requestODJ /localos on the member, reboot. Confirm with Get-ADComputer after.',
        ['ad', 'smb', 'join'],
      )
    },
  },
  {
    name: 'cli-dropped-bearer',
    match: (h) => {
      if (/missing access token/i.test(h)) {
        return lesson(
          'cli-dropped-bearer',
          'rterm-cli.native-ws.dropped-authorization',
          'rterm-cli remote gateway closes with missing access token',
          'On Node >= 21 the CLI used native WebSocket without the options object, so Authorization Bearer was never sent. Localhost (token-exempt) still worked, which looks like a server bug.',
          'Do not debug the remote daemon first when localhost ping works and remote ping dies with Connection closed before response.',
          'Send the token both as ?access_token= (query param) AND as the Authorization header on native WebSocket / ws.',
          ['cli', 'gateway'],
        )
      }
      if (/connection closed before response/i.test(h) && /token|gateway|rterm-cli|websocket/i.test(h)) {
        return lesson(
          'cli-dropped-bearer',
          'rterm-cli.native-ws.dropped-authorization',
          'rterm-cli remote gateway closes with missing access token',
          'On Node >= 21 the CLI used native WebSocket without the options object, so Authorization Bearer was never sent.',
          'Do not debug the remote daemon first when localhost ping works and remote ping dies with Connection closed before response.',
          'Send the token both as ?access_token= AND as the Authorization header.',
          ['cli', 'gateway'],
        )
      }
      return null
    },
  },
  {
    name: 'duplicate-tools',
    match: (h) => {
      if (!/duplicate tool/i.test(h)) return null
      return lesson(
        'duplicate-tools',
        'agent.duplicate-tool-definitions',
        'Provider HTTP 400: duplicate tool definitions',
        'Plugin tool schemas were appended twice (session cache + bind-time). Strict providers (Grok, Fable) reject the request.',
        'Do not append plugin tools both at session-bind cache time and again at bindTools() time.',
        'Keep plugin schemas only at bind-time (freshest) and run dedupeToolsByName() on every bindTools() call.',
        ['agent', 'tools'],
      )
    },
  },
  {
    name: 'npm-eacces-root-cache',
    match: (h) => {
      if (!/eacces/i.test(h)) return null
      if (!/root-owned|cache folder|npm/i.test(h)) return null
      return lesson(
        'npm-eacces-root-cache',
        'npm.eacces.root-owned-cache',
        'npm install -g fails with EACCES on a root-owned cache',
        'A past sudo npm left root-owned files in ~/.npm-cache. Retrying with sudo is the wrong fix in an agent context.',
        'Do not sudo npm install to fix EACCES when the cache is root-owned.',
        'Retry once with npm install -g <pkg> --cache /tmp/npm-fresh (or the lifecycle script npmInstallG path).',
        ['npm'],
      )
    },
  },
  {
    name: 'psrp-basic-401-after-dc',
    match: (h) => {
      const unauthorized = /\b401\b/.test(h) || /unauthorized/i.test(h)
      if (!unauthorized) return null
      if (!/psrp|winrm|basic/i.test(h)) return null
      const afterDc =
        /domain.?controller|addsforest|dcpromo|corp\.local|promoted|after promotion/i.test(h)
      if (!afterDc && !/basic/i.test(h)) return null
      if (!afterDc && !(/basic/i.test(h) && /401|unauthorized/i.test(h) && /psrp|winrm/i.test(h))) {
        return null
      }
      return lesson(
        'psrp-basic-401-after-dc',
        'ad.dc.basic-401-use-negotiate',
        'PSRP/WinRM Basic 401 after promoting a DC',
        'After Install-ADDSForest the machine is a DC. Basic auth to the same Administrator password often 401s; Negotiate/NTLMv2 with CORP\\Administrator still works.',
        'Do not keep using auth:basic against a box you just promoted to a DC.',
        'Switch the saved connection to transport:psrp auth:negotiate domain:CORP username:Administrator (as CORP-DC1).',
        ['ad', 'psrp', 'auth'],
      )
    },
  },
  {
    name: 'winrm-dollar-mangle',
    match: (h) => {
      if (/was unexpected at this time/i.test(h)) {
        return lesson(
          'winrm-dollar-mangle',
          'winrm.cmd-wrapping.dollar-mangle',
          'WinRM cmd wrapping eats $variables in PowerShell',
          'HTTP WinRM tabs often wrap through cmd.exe, so $env:FOO is expanded/eaten before PowerShell sees it.',
          'Do not send $env: / $foo on an HTTP WinRM tab and treat empty output as "the box has no env".',
          'Use PSRP (script in the message body) or Write-Output ((Get-CimInstance ...)) forms that avoid $.',
          ['winrm'],
        )
      }
      if (/\$env:COMPUTERNAME/.test(h) && /empty|undefined|mangle/i.test(h)) {
        return lesson(
          'winrm-dollar-mangle',
          'winrm.cmd-wrapping.dollar-mangle',
          'WinRM cmd wrapping eats $variables in PowerShell',
          'HTTP WinRM tabs often wrap through cmd.exe.',
          'Do not send $env: on an HTTP WinRM tab.',
          'Use PSRP or CIM cmdlets without $env:.',
          ['winrm'],
        )
      }
      return null
    },
  },
  {
    name: 'soap-guess-loop',
    match: (h) => {
      if (!/invalidselectors/i.test(h)) return null
      if (!/optionset|xmlns:|sessionid|keep-alive|prefix/i.test(h)) return null
      if (!/still fail|same fault|another.*probe|tweak/i.test(h)) return null
      return lesson(
        'soap-guess-loop',
        'psrp.soap-guessing-vs-payload',
        'SOAP header tweaks do not fix PSRP InvalidSelectors',
        'When Create succeeds and Receive fails, the envelope is probably already fine. Further OptionSet/prefix/SessionId changes waste the session.',
        'Do not run another uninstrumented live SOAP probe after 2+ identical InvalidSelectors.',
        'Dump creationXml fragments (struct dest/type at bytes 0-8 of each PSRP message) and diff against pypsrp.',
        ['psrp'],
      )
    },
  },
  {
    name: 'exec-command-multiline-poison',
    match: (h) => {
      if (/echo-mangled/i.test(h) || /only the first export/i.test(h) || /dquote prompt/i.test(h)) {
        return lesson(
          'exec-command-multiline-poison',
          'agent.exec_command.multiline-export',
          'Multi-line export/python -c in exec_command only runs the first line',
          'GyShell exec_command with separate export lines or inline python3 -c heredocs gets echo-mangled or only the first statement runs.',
          'Do not put multiple export X= lines on separate exec_command invocations expecting them to share a shell, and do not use inline python3 -c with nested quotes.',
          'One line with semicolons, or write_file a script then exec it. Password via stdin, never argv.',
          ['agent', 'shell'],
        )
      }
      return null
    },
  },
]

export function extractLessons(...parts: Array<string | undefined | null>): ExtractedLesson[] {
  const haystack = parts.filter(Boolean).join('\n')
  if (!haystack.trim()) return []
  const byFp = new Map<string, ExtractedLesson>()
  for (const ex of EXTRACTORS) {
    const hit = ex.match(haystack)
    if (hit && !byFp.has(hit.fingerprint)) byFp.set(hit.fingerprint, hit)
  }
  return [...byFp.values()]
}

export function formatLessonMarkdown(
  item: ExtractedLesson,
  meta: { runId?: string; at?: string; occurrence?: number },
): string {
  const at = meta.at || new Date().toISOString().slice(0, 10)
  const occ = meta.occurrence && meta.occurrence > 1 ? ` (seen x${meta.occurrence})` : ''
  const run = meta.runId ? ` run ${meta.runId}` : ''
  return [
    `## LESSON (auto, ${at},${run})${occ}`,
    '',
    `**${item.title}**`,
    '',
    item.body,
    '',
    `- NEVER: ${item.neverDo}`,
    `- INSTEAD: ${item.instead}`,
    `- fingerprint: \`${item.fingerprint}\``,
    '',
  ].join('\n')
}

export function memoryHasFingerprint(memory: string, fingerprint: string): boolean {
  return memory.includes('`' + fingerprint + '`') || memory.includes('\n' + fingerprint + '\n')
}

export function appendLessonsToMemory(
  current: string,
  lessons: ExtractedLesson[],
  meta: { runId?: string; at?: string },
): { next: string; added: string[] } {
  let next = current.endsWith('\n') || current === '' ? current : current + '\n'
  if (!next.trim()) next = '# Memory\n\n- Add durable cross-session notes here.\n\n'
  const added: string[] = []
  for (const item of lessons) {
    if (memoryHasFingerprint(next, item.fingerprint)) continue
    next += formatLessonMarkdown(item, meta)
    added.push(item.fingerprint)
  }
  return { next, added }
}

export const GATED_MUTATIONS: Array<{ id: string; re: RegExp; requireProbeTag: string }> = [
  { id: 'Add-Computer', re: /\bAdd-Computer\b/i, requireProbeTag: 'ad-join' },
  { id: 'Install-ADDSForest', re: /\bInstall-ADDSForest\b/i, requireProbeTag: 'ad-promo' },
  { id: 'djoin-provision', re: /\bdjoin(\.exe)?\s+\/provision\b/i, requireProbeTag: 'ad-join' },
  { id: 'Set-SmbServerConfiguration', re: /\bSet-SmbServerConfiguration\b/i, requireProbeTag: 'smb' },
  { id: 'sg-ingress', re: /\bauthorize-security-group-ingress\b/i, requireProbeTag: 'aws-sg' },
  { id: 'Remove-ADComputer', re: /\bRemove-ADComputer\b/i, requireProbeTag: 'ad-join' },
  { id: 'Format-Volume', re: /\bFormat-Volume\b/i, requireProbeTag: 'disk' },
  { id: 'Uninstall-WindowsFeature', re: /\bUninstall-WindowsFeature\b/i, requireProbeTag: 'windows-feature' },
]

export function matchGatedMutation(command: string): { id: string; requireProbeTag: string } | null {
  const c = command.trim()
  for (const g of GATED_MUTATIONS) {
    if (g.re.test(c)) return { id: g.id, requireProbeTag: g.requireProbeTag }
  }
  return null
}

export const REVIEW_VERBS: Array<{ id: string; re: RegExp }> = [
  { id: 'Install-ADDSForest', re: /\bInstall-ADDSForest\b/i },
  { id: 'Add-Computer', re: /\bAdd-Computer\b/i },
  { id: 'djoin', re: /\bdjoin(\.exe)?\b/i },
  { id: 'Set-SmbServerConfiguration', re: /\bSet-SmbServerConfiguration\b/i },
  { id: 'authorize-security-group-ingress', re: /\bauthorize-security-group-ingress\b/i },
  { id: 'Remove-Item -Recurse', re: /\bRemove-Item\b.*(-Recurse|-Force)/i },
  { id: 'Format-Volume', re: /\bFormat-Volume\b/i },
]

export function matchReviewVerb(command: string): string | null {
  for (const v of REVIEW_VERBS) {
    if (v.re.test(command)) return v.id
  }
  return null
}

export function connectionIdentity(opts: {
  name?: string
  host?: string
  transport?: string
  auth?: string
  domain?: string
}): string {
  if (opts.name && opts.name.trim()) return opts.name.trim()
  const host = (opts.host || '').trim() || 'unknown-host'
  const rest = [opts.transport, opts.auth, opts.domain].filter(Boolean).join('/')
  return rest ? `${host} (${rest})` : host
}
