import type { AlertChannel, AlertGroup, AlertSeverity } from '../sre/alertService'

/**
 * NotifyService — Slack / Microsoft Teams / Email-SMTP notification channels.
 *
 * Three channel factories that produce `AlertChannel`s ready to plug into the
 * existing `AlertService.channels` (v2.0.0 alert routing). Each builds a rich,
 * severity-colored payload for its platform and sends it via an injected HTTP
 * fetcher (so it's fully unit-testable offline). Pure + injectable — no direct
 * network dependency; a `fetchFn`/`smtpFn` is injected.
 */

export interface HttpFetchFn {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
}

export interface SmtpSendFn {
  (mail: { from: string; to: string[]; subject: string; text: string; html: string }): Promise<string>
}

export interface SlackOptions { webhookUrl: string; username?: string; minSeverity?: AlertSeverity }
export interface TeamsOptions { webhookUrl: string; minSeverity?: AlertSeverity }
export interface SmtpOptions {
  from: string
  to: string[]
  /** human label for the channel (e.g. 'smtp-oncall'). */
  name?: string
  minSeverity?: AlertSeverity
}

const SEV_COLOR: Record<AlertSeverity, string> = {
  info: '#0b7285',
  warning: '#b45309',
  critical: '#c92a2a',
}
const SEV_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔥',
}

function sevColor(sev: AlertSeverity): string { return SEV_COLOR[sev] }
function sevEmoji(sev: AlertSeverity): string { return SEV_EMOJI[sev] }

function groupFacts(group: AlertGroup): Array<{ name: string; value: string }> {
  const a = group.lastAlert
  const facts: Array<{ name: string; value: string }> = [
    { name: 'Severity', value: group.severity.toUpperCase() },
    { name: 'Source', value: a.source },
    { name: 'Count', value: `x${group.count}` },
  ]
  if (a.detail) facts.push({ name: 'Detail', value: a.detail.slice(0, 400) })
  if (a.labels) {
    for (const [k, v] of Object.entries(a.labels)) facts.push({ name: k, value: v })
  }
  facts.push({ name: 'Time', value: new Date(group.lastAt).toISOString() })
  return facts
}

// ---------------------------------------------------------------------------
// Slack — incoming-webhook Block Kit with a severity-colored attachment
// ---------------------------------------------------------------------------
export function buildSlackPayload(group: AlertGroup): Record<string, unknown> {
  const a = group.lastAlert
  return {
    username: 'RTerm',
    attachments: [
      {
        color: sevColor(group.severity),
        title: `${sevEmoji(group.severity)} ${group.title}`,
        title_link: undefined,
        text: a.detail ? a.detail.slice(0, 500) : undefined,
        fields: groupFacts(group).map((f) => ({ title: f.name, value: f.value, short: f.value.length < 40 })),
        footer: `RTerm AlertService • fingerprint ${group.fingerprint}`,
        ts: Math.floor(group.lastAt / 1000),
      },
    ],
  }
}

export function slackChannel(opts: SlackOptions, fetchFn: HttpFetchFn): AlertChannel {
  return {
    name: 'slack',
    ...(opts.minSeverity ? { minSeverity: opts.minSeverity } : {}),
    send: async (group: AlertGroup) => {
      const payload = buildSlackPayload(group)
      if (opts.username) payload.username = opts.username
      const res = await fetchFn(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`slack webhook ${res.status}: ${await res.text()}`)
      return `slack ${res.status}`
    },
  }
}

// ---------------------------------------------------------------------------
// Microsoft Teams — Power Automate / webhook MessageCard with severity theme
// ---------------------------------------------------------------------------
export function buildTeamsPayload(group: AlertGroup): Record<string, unknown> {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: sevColor(group.severity).replace('#', ''),
    summary: group.title,
    sections: [
      {
        activityTitle: `${sevEmoji(group.severity)} ${group.title}`,
        activitySubtitle: `RTerm AlertService — ${group.lastAlert.source}`,
        activityImage: undefined,
        facts: groupFacts(group).map((f) => ({ name: f.name, value: f.value })),
        markdown: true,
      },
    ],
  }
}

export function teamsChannel(opts: TeamsOptions, fetchFn: HttpFetchFn): AlertChannel {
  return {
    name: 'teams',
    ...(opts.minSeverity ? { minSeverity: opts.minSeverity } : {}),
    send: async (group: AlertGroup) => {
      const payload = buildTeamsPayload(group)
      const res = await fetchFn(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`teams webhook ${res.status}: ${await res.text()}`)
      return `teams ${res.status}`
    },
  }
}

// ---------------------------------------------------------------------------
// Email / SMTP — HTML + text via an injected sender (nodemailer-compatible)
// ---------------------------------------------------------------------------
export function buildEmail(group: AlertGroup, from: string, to: string[]): { from: string; to: string[]; subject: string; text: string; html: string } {
  const a = group.lastAlert
  const factsRows = groupFacts(group)
    .map((f) => `<tr><td style="padding:2px 12px 2px 0;color:#66727d">${f.name}</td><td>${escapeHtml(f.value)}</td></tr>`)
    .join('')
  const html = `<div style="font-family:sans-serif;max-width:560px">` +
    `<div style="border-left:4px solid ${sevColor(group.severity)};padding:8px 12px;background:#f6f8fa">` +
    `<b>${sevEmoji(group.severity)} ${escapeHtml(group.title)}</b></div>` +
    (a.detail ? `<p>${escapeHtml(a.detail)}</p>` : '') +
    `<table style="font-size:13px;margin-top:8px">${factsRows}</table>` +
    `<p style="color:#98a4ae;font-size:11px">RTerm AlertService • ${escapeHtml(group.fingerprint)}</p></div>`
  const text = `${sevEmoji(group.severity)} ${group.title}\n\n` +
    (a.detail ? `${a.detail}\n\n` : '') +
    groupFacts(group).map((f) => `${f.name}: ${f.value}`).join('\n') +
    `\n\nRTerm AlertService • ${group.fingerprint}`
  return {
    from,
    to,
    subject: `[${group.severity.toUpperCase()}] ${group.title}`,
    text,
    html,
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function smtpChannel(opts: SmtpOptions, smtpFn: SmtpSendFn): AlertChannel {
  return {
    name: opts.name ?? 'email',
    ...(opts.minSeverity ? { minSeverity: opts.minSeverity } : {}),
    send: async (group: AlertGroup) => {
      const mail = buildEmail(group, opts.from, opts.to)
      return smtpFn(mail)
    },
  }
}

// ---------------------------------------------------------------------------
// Telegram — chat-message channel (reuses the proven pattern from the AV demo)
// ---------------------------------------------------------------------------
export function buildTelegramPayload(chatId: string, group: AlertGroup): Record<string, unknown> {
  const a = group.lastAlert
  const lines = [
    `${sevEmoji(group.severity)} *${escapeMd(group.title)}*`,
    ``,
    `*Severity:* ${group.severity.toUpperCase()}`,
    `*Source:* ${escapeMd(a.source)}`,
    `*Count:* x${group.count}`,
  ]
  if (a.detail) lines.push(`*Detail:* ${escapeMd(a.detail.slice(0, 400))}`)
  if (a.labels) for (const [k, v] of Object.entries(a.labels)) lines.push(`*${escapeMd(k)}:* ${escapeMd(v)}`)
  lines.push(`_RTerm AlertService_`)
  return { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' }
}

function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c) => `\\${c}`)
}

export function telegramChannel(opts: { botToken: string; chatId: string; minSeverity?: AlertSeverity }, fetchFn: HttpFetchFn): AlertChannel {
  return {
    name: 'telegram',
    ...(opts.minSeverity ? { minSeverity: opts.minSeverity } : {}),
    send: async (group: AlertGroup) => {
      const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`
      const payload = buildTelegramPayload(opts.chatId, group)
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`)
      return `telegram ${res.status}`
    },
  }
}
