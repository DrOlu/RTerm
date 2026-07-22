// fraudops plugin type declarations
export function register(ctx: any): void
export function buildPipelineHealthCommand(): string
export function buildNatsStatusCommand(): string
export function buildKafkaLagCommand(): string
export function parsePipelineHealth(output: string): { status: string; jobs: any[]; running: number; failed: number }
export function buildStrCase(txnId: string, decision: string, indicators?: string[], assignedTo?: string): any
export function buildDecisionSummary(decisions: Array<{ decision: string }>): { total: number; blocks: number; reviews: number; approves: number; blockRate: number; reviewRate: number; approveRate: number }
export default any
