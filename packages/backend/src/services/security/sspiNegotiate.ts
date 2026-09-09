/**
 * SSPI / current-user Negotiate (v3.8.0).
 * On non-Windows (this Mac), always false — password auth remains required.
 * On Windows, callers may later bind native SSPI; this module documents the contract.
 */

export function sspiAvailable(): boolean {
  return process.platform === 'win32'
}

export function usesCurrentUser(username: string, password: string): boolean {
  return sspiAvailable() && !String(password || '').trim() && !String(username || '').trim()
}

export const WSMAN_SPN = (fqdn: string) => `WSMAN/${fqdn}`
