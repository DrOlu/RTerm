// iam-connector plugin type declarations
export function register(ctx: any): void
export function buildUserInfoCommand(username: string, os?: string): string
export function buildUserGroupsCommand(username: string, os?: string): string
export function buildDisableUserCommand(username: string, os?: string): string
export function buildAccessReviewCommand(os?: string): string
export function parseUserInfo(output: string, os?: string): { username: string; groups: string[]; enabled: boolean; locked: boolean }
export function parseAccessReview(output: string, os?: string): Array<{ username: string; groups?: string[]; enabled?: boolean }>
export function isPrivileged(userInfo: { groups: string[] }, privilegedGroups?: string[]): boolean
declare const _default: any
export default _default
