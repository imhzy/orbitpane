import { readJson, readText } from './storage'

export type ThemePreference = 'dark' | 'light' | 'system'
export type SettingsSection = 'general' | 'plugins' | 'ai' | 'notifications' | 'data' | 'security' | 'about' | 'project'

export interface AppPreferences {
  theme: ThemePreference
  defaultProvider: string
  defaultModels: Record<string, string>
  workspaceRoot: string
  desktopNotifications: boolean
}

export const PREFERENCES_KEY = 'orbitpane_preferences_v1'
const SECTIONS: SettingsSection[] = ['general', 'plugins', 'ai', 'notifications', 'data', 'security', 'about', 'project']

export function readPreferences(): AppPreferences {
  const value = readJson<unknown>(PREFERENCES_KEY, {})
  const raw = value && typeof value === 'object' ? value as Partial<AppPreferences> : {}
  const defaultModels = raw.defaultModels && typeof raw.defaultModels === 'object'
    ? Object.fromEntries(Object.entries(raw.defaultModels).filter(([, model]) => typeof model === 'string'))
    : {}
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
      ? raw.theme : readText('theme') === 'light' ? 'light' : 'dark',
    defaultProvider: typeof raw.defaultProvider === 'string' ? raw.defaultProvider : '',
    defaultModels,
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
    desktopNotifications: raw.desktopNotifications !== false,
  }
}

export function readSettingsLocation() {
  const params = new URLSearchParams(window.location.search)
  const section = params.get('settings')
  const projectId = Number(params.get('settings-project'))
  return {
    section: SECTIONS.includes(section as SettingsSection) ? section as SettingsSection : null,
    projectId: Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null,
  }
}
