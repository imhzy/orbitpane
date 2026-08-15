import { notifyAuthExpired } from './auth'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Message to show the user for a failed request.
 *
 * The backend already explains *why* something was rejected ("Provider is not
 * available: antigravity"); throwing that away for a generic "操作失败" leaves
 * the user with nothing to act on.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) {
    return `${fallback}：${error.message}`
  }
  if (error instanceof TypeError) {
    return `${fallback}：无法连接后端服务`
  }
  return fallback
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
      cache: init.cache ?? 'no-store',
      signal: init.signal ?? controller.signal,
    })
    if (response.status === 401) notifyAuthExpired()

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(
        payload?.detail || `Request failed with status ${response.status}`,
        response.status,
      )
    }
    return payload as T
  } finally {
    window.clearTimeout(timeout)
  }
}
