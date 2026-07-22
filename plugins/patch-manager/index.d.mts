// patch-manager plugin type declarations
export function register(ctx: any): void
export function buildPatchStatusCommand(os: string): string
export function buildPatchApplyCommand(os: string, opts?: { severity?: string; dryRun?: boolean }): string
export function buildPrePatchCheckCommand(os: string): string
export function buildPostPatchCheckCommand(os: string): string
export function parsePatchStatus(output: string, os: string): { patches: Array<{ id: string; title: string; severity: string; os: string }>; summary: { total: number; critical: number; security: number; recommended: number } }
export function buildPatchPlan(host: string, os: string, patchStatus: any, opts?: { severity?: string }): any
export function buildComplianceReport(hostStatuses: Record<string, any>): any
declare const _default: any
export default _default
