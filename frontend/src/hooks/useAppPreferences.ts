import { useCallback, useEffect, useState } from 'react'
import { PREFERENCES_KEY, readPreferences } from '../lib/preferences'
import type { AppPreferences } from '../lib/preferences'
import { writeJson, writeText } from '../lib/storage'

export function useAppPreferences() {
  const [preferences, setPreferences] = useState(readPreferences)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = preferences.theme === 'system' ? systemDark ? 'dark' : 'light' : preferences.theme

  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    setPreferences(previous => {
      const next = { ...previous, ...patch }
      writeJson(PREFERENCES_KEY, next)
      return next
    })
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setSystemDark(query.matches)
    query.addEventListener('change', sync)
    const onStorage = (event: StorageEvent) => {
      if (event.key === PREFERENCES_KEY || event.key === null) setPreferences(readPreferences())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      query.removeEventListener('change', sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    writeText('theme', theme)
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
      meta.setAttribute('content', theme === 'dark' ? '#0c0c0b' : '#faf9f8')
    })
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.density = preferences.density || 'comfortable'
  }, [preferences.density])

  const toggleTheme = useCallback(() => {
    updatePreferences({ theme: theme === 'dark' ? 'light' : 'dark' })
  }, [theme, updatePreferences])

  return { preferences, updatePreferences, theme, toggleTheme }
}
