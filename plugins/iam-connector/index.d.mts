// iam-connector plugin type declarations
export function register(ctx: any): void
export function buildUserInfoCommand(username: string, os?: string): string
export function buildUserGroupsCommand(username: string, os?: string): string
export function buildDisableUserCommand(username: string, os?: string): string
export function buildAccessReviewCommand(os?: string): string
export function parseUserInfo(output: string | null | undefined, os?: string | null | undefined): { username: string; groups: string[]; enabled: boolean; locked: boolean }
export function parseAccessReview(output: string | null | undefined, os?: string | null | undefined): Array<{ username: string; groups?: string[]; enabled?: boolean }>
export function isPrivileged(userInfo: { groups: string[] } | null | undefined, privilegedGroups?: string[] | null | undefined): boolean
export default any
