/**
 * Client half of the share-link contract.
 *
 * The route prefix mirrors `SHARE_URL_PREFIX` in `backend/app/application.py`;
 * the backend returns a path rather than a full URL so the link is always built
 * from the origin the browser is already on, never from a proxied Host header.
 */
export const SHARE_ROUTE_PREFIX = '/s/'

/**
 * The token in `/s/<token>`, or null when this is an ordinary app route.
 *
 * Anything after the prefix counts as a token attempt: a malformed one belongs
 * on the "link is not valid" page, not on the login screen of a private app.
 */
export function readShareToken(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_ROUTE_PREFIX)) return null
  return pathname.slice(SHARE_ROUTE_PREFIX.length).replace(/\/+$/, '') || null
}

export function absoluteShareUrl(urlPath: string): string {
  return new URL(urlPath, window.location.origin).toString()
}
