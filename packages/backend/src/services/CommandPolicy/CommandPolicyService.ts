import path from 'path'
import { app, shell } from 'electron'
import { BashArity } from './commandArity'
import { getBashParser } from './commandParser'
import {
  FileCommandPolicyStore,
  type CommandPolicyMode,
  type CommandPolicyLists,
  type CommandPolicyListName,
  type CommandPatternEntry
} from '../../command-policy/FileCommandPolicyStore'

const DEFAULT_POLICY_FILE_CONTENT = {
  allowlist: [],
  denylist: [],
  asklist: [],
  __syntax_note:
    "Wildcard rules: '*' matches any characters, '?' matches one character. A trailing ' *' (space + star) matches both the command alone and the command with args. Examples: 'ls *' matches 'ls' and 'ls -la'; 'ls' matches only 'ls'; 'ls -la' matches only that exact command."
}

export type { CommandPolicyMode, CommandPolicyLists, CommandPolicyListName }

export class CommandPolicyService {
  private readonly store: FileCommandPolicyStore

  constructor() {
    this.store = new FileCommandPolicyStore({
      filePath: this.getPolicyFilePath(),
      defaultFileContent: DEFAULT_POLICY_FILE_CONTENT,
      resolveEntries: (command) => this.parseCommandEntries(command)
    })
  }

  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void {
    this.store.setFeedbackWaiter(waiter)
  }

  private resolvePolicyBaseDir(): string {
    const overrideDir = (process.env.GYSHELL_STORE_DIR || '').trim()
    if (overrideDir) {
      return overrideDir
    }

    if (app && typeof app.getPath === 'function') {
      try {
        return app.getPath('userData')
      } catch {
        // fall through to cwd fallback for test/runtime edge-cases
      }
    }

    return path.join(process.cwd(), '.gyshell-data')
  }

  getPolicyFilePath(): string {
    const baseDir = this.resolvePolicyBaseDir()
    return path.join(baseDir, 'command-policy.json')
  }

  async ensurePolicyFile(): Promise<void> {
    await this.store.ensurePolicyFile()
  }

  async openPolicyFile(): Promise<void> {
    await this.ensurePolicyFile()
    await shell.openPath(this.getPolicyFilePath())
  }

  async getLists(): Promise<CommandPolicyLists> {
    return this.store.getLists()
  }

  async addRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    return this.store.addRule(listName, rule)
  }

  async deleteRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    return this.store.deleteRule(listName, rule)
  }

  async evaluate(command: string, mode: CommandPolicyMode): Promise<'allow' | 'deny' | 'ask'> {
    return this.store.evaluate(command, mode)
  }

  async requestApproval(params: {
    sessionId: string
    messageId: string
    command: string
    toolName: string
    sendEvent: (sessionId: string, event: any) => void
    signal?: AbortSignal
  }): Promise<boolean> {
    return this.store.requestApproval(params)
  }

  private async parseCommandEntries(command: string): Promise<CommandPatternEntry[]> {
    const parser = await getBashParser()
    const tree = parser.parse(command)
    if (!tree) {
      throw new Error('Failed to parse command')
    }

    const entries: CommandPatternEntry[] = []
    for (const node of tree.rootNode.descendantsOfType('command')) {
      if (!node) continue

      const tokens: string[] = []
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i)
        if (!child) continue
        if (
          child.type !== 'command_name' &&
          child.type !== 'word' &&
          child.type !== 'string' &&
          child.type !== 'raw_string' &&
          child.type !== 'concatenation'
        ) {
          continue
        }
        tokens.push(child.text)
      }

      if (tokens.length === 0) continue

      const patterns = new Set<string>()
      patterns.add(tokens.join(' '))

      const prefix = BashArity.prefix(tokens).join(' ')
      if (prefix) {
        patterns.add(prefix + '*')
      }

      entries.push({ patterns: Array.from(patterns) })
    }

    return entries
  }
}
