import { useCallback, useEffect, useState } from 'react'
import { readSettingsLocation } from '../lib/preferences'
import type { SettingsSection } from '../lib/preferences'

export function useSettingsNavigation() {
  const [location, setLocation] = useState(readSettingsLocation)

  useEffect(() => {
    const sync = () => {
      const next = readSettingsLocation()
      setLocation(previous => previous.section === next.section && previous.projectId === next.projectId ? previous : next)
    }
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  const openSettings = useCallback((section: SettingsSection = 'general', projectId?: number) => {
    const alreadyOpen = readSettingsLocation().section !== null
    const url = new URL(window.location.href)
    url.searchParams.set('settings', section)
    if (projectId) url.searchParams.set('settings-project', String(projectId))
    else url.searchParams.delete('settings-project')
    if (alreadyOpen) window.history.replaceState(window.history.state, '', url.toString())
    else window.history.pushState({ ...window.history.state, orbitpaneSettings: true }, '', url.toString())
    setLocation(readSettingsLocation())
  }, [])

  const closeSettings = useCallback(() => {
    if (window.history.state?.orbitpaneSettings) {
      window.history.back()
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('settings')
    url.searchParams.delete('settings-project')
    window.history.replaceState(window.history.state, '', url.toString())
    setLocation(readSettingsLocation())
  }, [])

  return { settingsSection: location.section, settingsProjectId: location.projectId, openSettings, closeSettings }
}
