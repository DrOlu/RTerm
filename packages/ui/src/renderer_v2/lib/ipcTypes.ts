export type BackendSettings = Awaited<ReturnType<Window['gyshell']['settings']['get']>>
export type UiSettings = Awaited<ReturnType<Window['gyshell']['uiSettings']['get']>>
export type AppSettings = BackendSettings & UiSettings
export type TerminalConfig = Parameters<Window['gyshell']['terminal']['createTab']>[0]
export type FileSystemListResult = Awaited<ReturnType<Window['gyshell']['filesystem']['list']>>
export type FileSystemEntry = FileSystemListResult['entries'][number]

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
