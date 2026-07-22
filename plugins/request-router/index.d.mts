// request-router plugin type declarations
export function register(ctx: any): void
export function classifyRequest(request: any): string
export function routeRequest(request: any): { route: string; risk: string; reason: string }
export function buildRequestId(): string
export function buildApprovalRecord(requestId: string, approvedBy: string, rationale: string, decision: string): any
export function buildQueueEntry(request: any, requestId: string): any
export function filterQueue(queue: any[], filter?: any): any[]
declare const _default: any
export default _default
