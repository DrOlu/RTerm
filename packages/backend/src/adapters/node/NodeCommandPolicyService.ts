import path from 'node:path'
import {
  FileCommandPolicyStore,
  type CommandPolicyMode,
  type CommandPolicyLists,
  type CommandPolicyListName
} from '../../command-policy/FileCommandPolicyStore'

const DEFAULT_POLICY_FILE_CONTENT = {
  allowlist: [],
  denylist: [],
  asklist: []
}

export type { CommandPolicyMode, CommandPolicyLists, CommandPolicyListName }

export class NodeCommandPolicyService {
  private readonly store: FileCommandPolicyStore

  constructor(private readonly dataDir: string) {
    this.store = new FileCommandPolicyStore({
      filePath: path.join(this.dataDir, 'command-policy.json'),
      defaultFileContent: DEFAULT_POLICY_FILE_CONTENT
    })
  }

  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void {
    this.store.setFeedbackWaiter(waiter)
  }

  getPolicyFilePath(): string {
    return this.store.getPolicyFilePath()
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
}
