import { remove } from './storage'
export const AUTH_EXPIRED_EVENT = 'orbitpane:auth-expired'

export function clearLegacyAuthState(): void {
  // Legacy keys from the pre-cookie auth scheme.
  remove('orbitpane-auth-token')
  remove('orbitpane-token')
  remove('isLoggedIn')
}

export function notifyAuthExpired(): void {
  clearLegacyAuthState()
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
}
