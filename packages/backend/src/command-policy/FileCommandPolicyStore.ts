import fs from 'node:fs/promises'
import path from 'node:path'

export type CommandPolicyMode = 'safe' | 'standard' | 'smart'

export interface CommandPolicyLists {
  allowlist: string[]
  denylist: string[]
  asklist: string[]
}

export type CommandPolicyListName = keyof CommandPolicyLists

export interface CommandPatternEntry {
  patterns: string[]
}

export type CommandPatternResolver = (command: string) => Promise<CommandPatternEntry[]>

export interface FileCommandPolicyStoreOptions {
  filePath: string
  defaultFileContent?: Record<string, unknown>
  resolveEntries?: CommandPatternResolver
}

const DEFAULT_LISTS: CommandPolicyLists = {
  allowlist: [],
  denylist: [],
  asklist: []
}

function normalizeLists(raw: unknown): CommandPolicyLists {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LISTS }
  const value = raw as Record<string, unknown>
  return {
    allowlist: Array.isArray(value.allowlist) ? value.allowlist.map(String) : [],
    denylist: Array.isArray(value.denylist) ? value.denylist.map(String) : [],
    asklist: Array.isArray(value.asklist) ? value.asklist.map(String) : []
  }
}

export class FileCommandPolicyStore {
  private feedbackWaiter: ((messageId: string, timeoutMs?: number) => Promise<any | null>) | null = null

  constructor(private readonly options: FileCommandPolicyStoreOptions) {}

  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void {
    this.feedbackWaiter = waiter
  }

  getPolicyFilePath(): string {
    return this.options.filePath
  }

  async ensurePolicyFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true })
    const exists = await fs
      .access(this.options.filePath)
      .then(() => true)
      .catch(() => false)
    if (exists) return

    const defaultFile = {
      ...this.options.defaultFileContent,
      ...DEFAULT_LISTS
    }
    await fs.writeFile(this.options.filePath, JSON.stringify(defaultFile, null, 2), 'utf8')
  }

  async getLists(): Promise<CommandPolicyLists> {
    return this.loadLists()
  }

  async addRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    const trimmed = String(rule || '').trim()
    if (!trimmed) return this.loadLists()

    await this.ensurePolicyFile()
    const existingRaw = await this.readRawObject()
    const lists = normalizeLists(existingRaw)
    const target = new Set(lists[listName])
    target.add(trimmed)
    lists[listName] = Array.from(target).sort((a, b) => a.localeCompare(b))

    await this.writeRawObject({
      ...this.options.defaultFileContent,
      ...existingRaw,
      ...lists
    })

    return lists
  }

  async deleteRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    const trimmed = String(rule || '').trim()
    if (!trimmed) return this.loadLists()

    await this.ensurePolicyFile()
    const existingRaw = await this.readRawObject()
    const lists = normalizeLists(existingRaw)
    lists[listName] = lists[listName].filter((item) => item !== trimmed)

    await this.writeRawObject({
      ...this.options.defaultFileContent,
      ...existingRaw,
      ...lists
    })

    return lists
  }

  async evaluate(command: string, mode: CommandPolicyMode): Promise<'allow' | 'deny' | 'ask'> {
    const lists = await this.loadLists()
    const entries = await this.resolveEntries(command)

    if (entries.length === 0) {
      if (mode === 'safe') return 'deny'
      if (mode === 'standard') return 'ask'
      return 'allow'
    }

    let overallDecision: 'allow' | 'ask' | 'deny' = 'allow'

    for (const entry of entries) {
      let entryDecision: 'allow' | 'ask' | 'deny'

      if (this.matchesList(entry.patterns, lists.denylist)) {
        entryDecision = 'deny'
      } else if (this.matchesList(entry.patterns, lists.asklist)) {
        entryDecision = 'ask'
      } else if (this.matchesList(entry.patterns, lists.allowlist)) {
        entryDecision = 'allow'
      } else {
        if (mode === 'safe') entryDecision = 'deny'
        else if (mode === 'standard') entryDecision = 'ask'
        else entryDecision = 'allow'
      }

      if (entryDecision === 'deny') return 'deny'
      if (entryDecision === 'ask') overallDecision = 'ask'
    }

    return overallDecision
  }

  async requestApproval(params: {
    sessionId: string
    messageId: string
    command: string
    toolName: string
    sendEvent: (sessionId: string, event: any) => void
    signal?: AbortSignal
  }): Promise<boolean> {
    if (!this.feedbackWaiter) {
      throw new Error('Feedback waiter is not initialized')
    }
    const feedbackWaiter = this.feedbackWaiter

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => reject(new Error('AbortError'))

      if (params.signal) {
        if (params.signal.aborted) {
          onAbort()
          return
        }
        params.signal.addEventListener('abort', onAbort, { once: true })
      }

      params.sendEvent(params.sessionId, {
        type: 'command_ask',
        approvalId: params.messageId,
        command: params.command,
        toolName: params.toolName,
        messageId: params.messageId,
        decision: undefined
      })

      feedbackWaiter(params.messageId)
        .then((feedback) => {
          if (params.signal) {
            params.signal.removeEventListener('abort', onAbort)
          }
          resolve(Boolean(feedback && feedback.decision === 'allow'))
        })
        .catch(reject)
    })
  }

  private async resolveEntries(command: string): Promise<CommandPatternEntry[]> {
    const resolver = this.options.resolveEntries
    if (resolver) {
      try {
        const entries = await resolver(command)
        return Array.isArray(entries) ? entries.filter((entry) => entry.patterns.length > 0) : []
      } catch {
        return this.defaultResolveEntries(command)
      }
    }
    return this.defaultResolveEntries(command)
  }

  private defaultResolveEntries(command: string): CommandPatternEntry[] {
    const chunks = String(command || '')
      .split(/&&|\|\||;|\n/g)
      .map((entry) => entry.trim())
      .filter(Boolean)

    return chunks.map((entry) => {
      const first = entry.split(/\s+/)[0] || ''
      const patterns = new Set<string>()
      patterns.add(entry)
      if (first) {
        patterns.add(first)
      }
      return { patterns: Array.from(patterns) }
    })
  }

  private async loadLists(): Promise<CommandPolicyLists> {
    await this.ensurePolicyFile()
    return normalizeLists(await this.readRawObject())
  }

  private async readRawObject(): Promise<Record<string, unknown>> {
    await this.ensurePolicyFile()
    try {
      const raw = await fs.readFile(this.options.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  private async writeRawObject(value: Record<string, unknown>): Promise<void> {
    await this.ensurePolicyFile()
    await fs.writeFile(this.options.filePath, JSON.stringify(value, null, 2), 'utf8')
  }

  private matchesList(patterns: string[], rules: string[]): boolean {
    if (!patterns.length || !rules.length) return false
    for (const pattern of patterns) {
      for (const rule of rules) {
        if (this.matchWildcard(pattern, rule)) return true
      }
    }
    return false
  }

  private matchWildcard(text: string, pattern: string): boolean {
    let escaped = String(pattern || '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    // Keep compatibility with old "cmd *" semantics: match both "cmd" and "cmd ..."
    if (escaped.endsWith(' .*')) {
      escaped = escaped.slice(0, -3) + '( .*)?'
    }

    return new RegExp(`^${escaped}$`, 's').test(text)
  }
}

export { DEFAULT_LISTS }
