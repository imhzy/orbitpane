export const AUTH_EXPIRED_EVENT = 'agy:auth-expired'

export function clearLegacyAuthState(): void {
  localStorage.removeItem('agy-auth-token')
  localStorage.removeItem('agy-token')
  localStorage.removeItem('isLoggedIn')
}

export function notifyAuthExpired(): void {
  clearLegacyAuthState()
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
}
