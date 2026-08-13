export type HapticKind = 'selection' | 'light' | 'success' | 'warning'

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 10,
  light: 18,
  success: [18, 35, 24],
  warning: [30, 45, 30],
}

export function haptic(kind: HapticKind = 'selection') {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  navigator.vibrate(PATTERNS[kind])
}

export async function updateAppBadge(count: number) {
  if (typeof navigator === 'undefined') return
  const badgeNavigator = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (count > 0) await badgeNavigator.setAppBadge?.(count)
    else await badgeNavigator.clearAppBadge?.()
  } catch {
    // Badging is optional and may be blocked outside installed display modes.
  }
}
