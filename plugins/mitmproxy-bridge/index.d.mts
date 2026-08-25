// mitmproxy-bridge plugin type declarations
export function register(ctx: any): void
export function buildMitmCommand(opts: {
  mode?: 'regular' | 'reverse'
  listenPort?: number
  upstreamTarget?: string
  flowsFile: string
  filterExpr?: string
  extraArgs?: string[]
}): { cmd: string; args: string[] }
export function parseFlows(rawFlows: unknown): {
  total: number
  byHost: Record<string, { count: number; methods: Record<string, number> }>
  byStatus: Record<string, number>
  requests: Array<{ host: string; method: string; path: string; status: string; contentType: string }>
  error?: string
}
export function detectSecrets(text: string | null | undefined): Array<{ kind: string; count: number; preview: string }>
export function isHostAllowed(host: string, allowlist: string[]): boolean
export default any
