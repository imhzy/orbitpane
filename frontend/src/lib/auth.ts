export const AUTH_EXPIRED_EVENT = 'orbitpane:auth-expired'

export function clearLegacyAuthState(): void {
  localStorage.removeItem('orbitpane-auth-token')
  localStorage.removeItem('orbitpane-token')
  localStorage.removeItem('isLoggedIn')
}

export function notifyAuthExpired(): void {
  clearLegacyAuthState()
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
}
