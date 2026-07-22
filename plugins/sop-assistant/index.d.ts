// sop-assistant plugin type declarations
export function register(ctx: any): void
export function searchSops(query: string, sops?: any[]): Array<{ id: string; title: string; category: string; relevance: number; steps: number }>
export function getSop(id: string, sops?: any[]): any
export function searchIamPolicies(query: string, policies?: any[]): Array<{ id: string; title: string; category: string; relevance: number; rules: string[] }>
export function buildStepCommand(step: any, vars?: Record<string, any>): string
export const BUILTIN_SOPS: any[]
export const IAM_POLICIES: any[]
export default any
