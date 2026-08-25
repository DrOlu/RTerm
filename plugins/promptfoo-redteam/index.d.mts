// promptfoo-redteam plugin type declarations
export function register(ctx: any): void
export function buildPromptfooConfig(opts: {
  providers: Array<{ name: string; model: string; baseUrl?: string; apiKeyRef?: string }>
  tests: Array<{ vars: { prompt: string }; assert?: any[] }>
  description?: string
}): { description: string; prompts: string[]; providers: any[]; tests: any[] }
export function builtinRedteamTests(): Array<{ description: string; vars: { prompt: string }; assert: any[] }>
export function parsePromptfooResults(raw: unknown): {
  summary: { total: number; passed: number; failed: number; errors: number; byProvider: Record<string, { total: number; passed: number; failed: number }> }
  findings: Array<{ severity: string; category: string; provider: string; test: string; score: number; message: string }>
  error?: string
}
export function redteamVerdict(summary: { total: number; passed?: number; failed?: number; errors?: number } | null | undefined): string
export default any
