export const GATEWAY_URL_STORAGE_KEY = 'gyshell-mobile-gateway-url'
export const GATEWAY_AUTO_CONNECT_STORAGE_KEY = 'gyshell-mobile-gateway-auto-connect'
export const GATEWAY_ACCESS_TOKEN_STORAGE_KEY = 'gyshell-mobile-gateway-access-token'

function gatewayUrlFromQuery(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('gateway')
    if (!raw || !raw.trim()) {
      return null
    }
    return normalizeGatewayUrl(raw)
  } catch {
    return null
  }
}

export function defaultGatewayUrl(): string {
  const host = window.location.hostname || '127.0.0.1'
  return `ws://${host}:17888`
}

export function normalizeGatewayUrl(raw: string): string {
  const input = String(raw || '').trim()
  if (!input) return defaultGatewayUrl()
  if (input.startsWith('ws://') || input.startsWith('wss://')) return input
  if (input.startsWith('http://')) return `ws://${input.slice('http://'.length)}`
  if (input.startsWith('https://')) return `wss://${input.slice('https://'.length)}`
  return `ws://${input}`
}

export function loadGatewayUrlFromStorage(): string {
  return gatewayUrlFromQuery() || window.localStorage.getItem(GATEWAY_URL_STORAGE_KEY) || defaultGatewayUrl()
}

export function saveGatewayUrlToStorage(url: string): void {
  window.localStorage.setItem(GATEWAY_URL_STORAGE_KEY, url)
}

export function loadGatewayAccessTokenFromStorage(): string {
  return window.localStorage.getItem(GATEWAY_ACCESS_TOKEN_STORAGE_KEY) || ''
}

export function saveGatewayAccessTokenToStorage(token: string): void {
  window.localStorage.setItem(GATEWAY_ACCESS_TOKEN_STORAGE_KEY, String(token || '').trim())
}

export function loadGatewayAutoConnectFromStorage(): boolean {
  return window.localStorage.getItem(GATEWAY_AUTO_CONNECT_STORAGE_KEY) === '1'
}

export function saveGatewayAutoConnectToStorage(enabled: boolean): void {
  window.localStorage.setItem(GATEWAY_AUTO_CONNECT_STORAGE_KEY, enabled ? '1' : '0')
}

export function withGatewayAccessToken(url: string, accessTokenRaw: string): string {
  const accessToken = String(accessTokenRaw || '').trim()
  if (!accessToken) return url

  const normalized = normalizeGatewayUrl(url)
  try {
    const parsed = new URL(normalized)
    parsed.searchParams.set('access_token', accessToken)
    return parsed.toString()
  } catch {
    return normalized
  }
}

export function withoutGatewayAccessToken(url: string): string {
  const normalized = normalizeGatewayUrl(url)
  try {
    const parsed = new URL(normalized)
    parsed.searchParams.delete('access_token')
    return parsed.toString()
  } catch {
    return normalized
  }
}
