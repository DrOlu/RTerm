export type BackendSettings = Awaited<ReturnType<Window['gyshell']['settings']['get']>>
export type UiSettings = Awaited<ReturnType<Window['gyshell']['uiSettings']['get']>>
export type AppSettings = BackendSettings & UiSettings
export type TerminalConfig = Parameters<Window['gyshell']['terminal']['createTab']>[0]
export type FileSystemListResult = Awaited<ReturnType<Window['gyshell']['filesystem']['list']>>
export type FileSystemEntry = FileSystemListResult['entries'][number]
export type FileTransferTaskSnapshot = Awaited<ReturnType<Window['gyshell']['filesystem']['startTransfer']>>
export type MonitorSnapshot = Awaited<ReturnType<Window['gyshell']['monitor']['snapshot']>>

export type TerminalId = string

export type TerminalTabType = TerminalConfig['type']

export type ProxyEntry = BackendSettings['connections']['proxies'][number]
export type TunnelEntry = BackendSettings['connections']['tunnels'][number]

export enum PortForwardType {
  Local = 'Local',
  Remote = 'Remote',
  Dynamic = 'Dynamic'
}

export type AppLanguage = UiSettings['language']
export type ModelDefinition = BackendSettings['models']['items'][number]

/** The review/checker model — independently verifies the action model's output. */
export interface ModelProfile {
  id: string
  name: string
  globalModelId: string
  actionModelId?: string
  thinkingModelId?: string
  compactionModelId?: string
  /**
   * The review/checker model — independently verifies the action model's output
   * for correctness, completeness, safety, compliance, and accuracy.
   * If NOT specified, reviews are skipped entirely (fast output mode).
   */
  reviewModelId?: string
  /** how strict the review is: 'strict' (block on any issue), 'advisory' (flag but allow), 'auto-approve' (skip review for low-risk actions). */
  reviewMode?: 'strict' | 'advisory' | 'auto-approve'
}
