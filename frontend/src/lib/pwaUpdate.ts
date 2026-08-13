export type PwaUpdateResult = 'current' | 'updating' | 'reloading'

let registration: ServiceWorkerRegistration | undefined
let activateWaitingWorker: (() => Promise<void>) | undefined
let manualUpdateRequested = false

export function configurePwaUpdate(options: {
  registration?: ServiceWorkerRegistration
  activateWaitingWorker?: () => Promise<void>
}) {
  if (options.registration) registration = options.registration
  if (options.activateWaitingWorker) activateWaitingWorker = options.activateWaitingWorker
}

export function consumeManualUpdateRequest() {
  if (!manualUpdateRequested) return false
  manualUpdateRequested = false
  return true
}

export async function activatePwaUpdate() {
  manualUpdateRequested = false
  if (activateWaitingWorker) {
    let reloadTimer: ReturnType<typeof window.setTimeout> | undefined
    const reload = () => {
      if (reloadTimer) window.clearTimeout(reloadTimer)
      window.location.reload()
    }
    navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true })
    try {
      await activateWaitingWorker()
      // Safari standalone mode can occasionally delay Workbox's controlling
      // callback even after the new worker has activated.
      reloadTimer = window.setTimeout(reload, 5000)
    } catch (error) {
      navigator.serviceWorker?.removeEventListener('controllerchange', reload)
      throw error
    }
    return
  }
  window.location.reload()
}

export async function requestPwaUpdate(): Promise<PwaUpdateResult> {
  if (!('serviceWorker' in navigator)) {
    window.location.reload()
    return 'reloading'
  }

  if (!registration) registration = await navigator.serviceWorker.getRegistration()
  if (!registration) {
    // The first registration may still be starting. A network reload remains
    // the safest fallback for browsers without an active PWA worker.
    window.location.reload()
    return 'reloading'
  }

  if (registration.waiting) {
    await activatePwaUpdate()
    return 'reloading'
  }

  manualUpdateRequested = true
  let updateFound = false
  const handleUpdateFound = () => {
    updateFound = true
    const installingWorker = registration?.installing
    installingWorker?.addEventListener('statechange', () => {
      if (installingWorker.state === 'redundant') manualUpdateRequested = false
    })
  }

  registration.addEventListener('updatefound', handleUpdateFound, { once: true })
  try {
    await registration.update()
  } catch (error) {
    manualUpdateRequested = false
    throw error
  } finally {
    registration.removeEventListener('updatefound', handleUpdateFound)
  }

  if (registration.waiting) {
    await activatePwaUpdate()
    return 'reloading'
  }

  if (updateFound || registration.installing) return 'updating'

  manualUpdateRequested = false
  return 'current'
}
