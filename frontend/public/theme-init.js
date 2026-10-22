// Run before styles and the application bundle to avoid a dark first paint.
// Keep the preference key and validation aligned with lib/preferences.ts.
(() => {
  let preference = 'system'
  try {
    const saved = JSON.parse(localStorage.getItem('orbitpane_preferences_v1') || 'null')
    if (saved && ['light', 'dark', 'system'].includes(saved.theme)) preference = saved.theme
  } catch {
    // Blocked storage or invalid JSON should still follow the system.
  }
  const theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  document.documentElement.dataset.theme = theme
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    meta.content = theme === 'dark' ? '#0c0c0b' : '#f6f5f3'
  })
})()
