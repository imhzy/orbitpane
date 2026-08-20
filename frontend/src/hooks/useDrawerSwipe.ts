import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react'
import { animate, useMotionValue, useReducedMotion } from 'framer-motion'
import { haptic } from '../lib/nativeFeedback'

type DrawerMode = 'sessions' | 'create'

interface DrawerSwipeOptions {
  isDrawerOpen: boolean
  allowActionStarts?: boolean
  setIsDrawerOpen: Dispatch<SetStateAction<boolean>>
  setDrawerMode: Dispatch<SetStateAction<DrawerMode>>
}

interface PointerSample {
  x: number
  time: number
}

interface SwipeGesture {
  pointerId: number
  target: HTMLDivElement
  startX: number
  startY: number
  lastX: number
  drawerWidth: number
  directionLocked: boolean
  samples: PointerSample[]
  measureFrame: number | null
}

const OVERLAY_BREAKPOINT = 1024
const SYSTEM_GESTURE_INSET = 32
const DIRECTION_LOCK_DISTANCE = 10
const OPEN_PROGRESS_THRESHOLD = 0.38
const OPEN_FLICK_DISTANCE = 24
const OPEN_FLICK_VELOCITY = 500
const VELOCITY_WINDOW_MS = 120
const ALWAYS_RESERVED_GESTURE_SELECTOR = [
  '[data-drawer-swipe-ignore]',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]',
].join(',')
const ACTION_GESTURE_SELECTOR = 'a,button,[role="button"]'

function estimateDrawerWidth() {
  if (typeof window === 'undefined') return 340
  const viewportWidth = window.innerWidth
  return viewportWidth <= 768
    ? Math.min(310, viewportWidth * 0.86)
    : Math.min(340, viewportWidth * 0.88)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function recordSample(gesture: SwipeGesture, x: number, time: number) {
  gesture.samples.push({ x, time })
  const cutoff = time - VELOCITY_WINDOW_MS
  while (gesture.samples.length > 2 && gesture.samples[1].time < cutoff) {
    gesture.samples.shift()
  }
}

function releasePointer(gesture: SwipeGesture) {
  if (gesture.target.hasPointerCapture(gesture.pointerId)) {
    gesture.target.releasePointerCapture(gesture.pointerId)
  }
}

function gestureBelongsToNestedContent(
  target: EventTarget | null,
  boundary: HTMLElement,
  allowActionStarts: boolean,
) {
  const startElement = target instanceof Element ? target : null
  if (!startElement) return false

  const reservedElement = startElement.closest(ALWAYS_RESERVED_GESTURE_SELECTOR)
  if (reservedElement && boundary.contains(reservedElement)) return true
  if (!allowActionStarts) {
    const actionElement = startElement.closest(ACTION_GESTURE_SELECTOR)
    if (actionElement && boundary.contains(actionElement)) return true
  }

  // This also protects future carousels or horizontally scrolling content that
  // has not opted out explicitly. A nested scroller owns a gesture that starts
  // inside it; the drawer never steals the gesture at either scroll boundary.
  let element: HTMLElement | null = startElement instanceof HTMLElement
    ? startElement
    : startElement.parentElement
  while (element && element !== boundary) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const { overflowX } = window.getComputedStyle(element)
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    element = element.parentElement
  }
  return false
}

/**
 * Drives an interactive drawer reveal from inside the message viewport.
 *
 * Android reserves the physical screen edge for system Back, so the recognizer
 * deliberately rejects starts in that inset. Nested horizontal scrollers and
 * controls keep ownership of their gestures; ordinary message content reveals
 * the drawer only after an unambiguous rightward direction lock.
 */
export function useDrawerSwipe({
  isDrawerOpen,
  allowActionStarts = false,
  setIsDrawerOpen,
  setDrawerMode,
}: DrawerSwipeOptions) {
  const prefersReducedMotion = useReducedMotion()
  const drawerX = useMotionValue(-estimateDrawerWidth())
  const scrimOpacity = useMotionValue(0)
  const gestureRef = useRef<SwipeGesture | null>(null)
  const settleAnimationsRef = useRef<Array<{ stop: () => void }>>([])
  const settleGenerationRef = useRef(0)
  const suppressClickUntilRef = useRef(0)
  const [isRevealing, setIsRevealing] = useState(false)

  const stopSettleAnimations = useCallback(() => {
    settleGenerationRef.current += 1
    settleAnimationsRef.current.forEach(control => control.stop())
    settleAnimationsRef.current = []
  }, [])

  const updateReveal = useCallback((gesture: SwipeGesture, clientX: number) => {
    gesture.lastX = clientX
    const revealed = clamp(clientX - gesture.startX, 0, gesture.drawerWidth)
    drawerX.set(revealed - gesture.drawerWidth)
    scrimOpacity.set(revealed / gesture.drawerWidth)
  }, [drawerX, scrimOpacity])

  const settleReveal = useCallback((shouldOpen: boolean, drawerWidth: number) => {
    stopSettleAnimations()
    const generation = settleGenerationRef.current
    const targetX = shouldOpen ? 0 : -drawerWidth
    const targetOpacity = shouldOpen ? 1 : 0

    if (shouldOpen) {
      haptic('light')
      setIsDrawerOpen(true)
    }

    const positionAnimation = animate(drawerX, targetX, {
      ...(prefersReducedMotion
        ? { duration: 0 }
        : { type: 'spring' as const, stiffness: 420, damping: 40, mass: 0.82 }),
      onComplete: () => {
        if (generation !== settleGenerationRef.current) return
        settleAnimationsRef.current = []
        drawerX.set(targetX)
        scrimOpacity.set(targetOpacity)
        setIsRevealing(false)
      },
    })
    const scrimAnimation = animate(scrimOpacity, targetOpacity, {
      duration: prefersReducedMotion ? 0 : 0.18,
      ease: 'easeOut',
    })
    settleAnimationsRef.current = [positionAnimation, scrimAnimation]
  }, [drawerX, prefersReducedMotion, scrimOpacity, setIsDrawerOpen, stopSettleAnimations])

  const abandonGesture = useCallback((gesture: SwipeGesture) => {
    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    releasePointer(gesture)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== 'touch'
      || !event.isPrimary
      || isDrawerOpen
      || isRevealing
      || window.innerWidth >= OVERLAY_BREAKPOINT
      || document.querySelector('[aria-modal="true"]')
      || event.clientX < (window.visualViewport?.offsetLeft ?? 0) + SYSTEM_GESTURE_INSET
      || gestureBelongsToNestedContent(event.target, event.currentTarget, allowActionStarts)
    ) return

    stopSettleAnimations()
    const drawerWidth = estimateDrawerWidth()
    drawerX.set(-drawerWidth)
    scrimOpacity.set(0)
    const gesture: SwipeGesture = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      drawerWidth,
      directionLocked: false,
      samples: [{ x: event.clientX, time: event.timeStamp }],
      measureFrame: null,
    }
    gestureRef.current = gesture
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [allowActionStarts, drawerX, isDrawerOpen, isRevealing, scrimOpacity, stopSettleAnimations])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY
    const absoluteY = Math.abs(deltaY)

    if (!gesture.directionLocked) {
      if (
        deltaX < -DIRECTION_LOCK_DISTANCE
        || (absoluteY >= DIRECTION_LOCK_DISTANCE && absoluteY > Math.abs(deltaX))
      ) {
        abandonGesture(gesture)
        return
      }
      if (deltaX < DIRECTION_LOCK_DISTANCE || deltaX <= absoluteY * 1.2) return

      gesture.directionLocked = true
      setDrawerMode('sessions')
      setIsRevealing(true)

      // The estimate matches the CSS and makes the first frame immediate. Once
      // React mounts the drawer, measure it so future CSS width changes do not
      // make the final few pixels drift away from the finger.
      gesture.measureFrame = window.requestAnimationFrame(() => {
        gesture.measureFrame = null
        if (gestureRef.current !== gesture) return
        const renderedWidth = document.querySelector<HTMLElement>('.drawer')?.offsetWidth
        if (!renderedWidth || renderedWidth === gesture.drawerWidth) return
        gesture.drawerWidth = renderedWidth
        updateReveal(gesture, gesture.lastX)
      })
    }

    recordSample(gesture, event.clientX, event.timeStamp)
    updateReveal(gesture, event.clientX)
    if (event.cancelable) event.preventDefault()
  }, [abandonGesture, setDrawerMode, updateReveal])

  const finishGesture = useCallback((event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    if (!cancelled && gesture.directionLocked) {
      recordSample(gesture, event.clientX, event.timeStamp)
      updateReveal(gesture, event.clientX)
    }

    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    releasePointer(gesture)

    if (!gesture.directionLocked) return
    suppressClickUntilRef.current = performance.now() + 400

    const revealed = clamp(gesture.lastX - gesture.startX, 0, gesture.drawerWidth)
    const firstSample = gesture.samples[0]
    const lastSample = gesture.samples[gesture.samples.length - 1]
    const elapsed = Math.max(lastSample.time - firstSample.time, 1)
    const velocity = ((lastSample.x - firstSample.x) / elapsed) * 1000
    const shouldOpen = !cancelled && (
      revealed / gesture.drawerWidth >= OPEN_PROGRESS_THRESHOLD
      || (revealed >= OPEN_FLICK_DISTANCE && velocity >= OPEN_FLICK_VELOCITY)
    )
    settleReveal(shouldOpen, gesture.drawerWidth)
  }, [settleReveal, updateReveal])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishGesture(event, false)
  }, [finishGesture])

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishGesture(event, true)
  }, [finishGesture])

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    if (gesture.directionLocked) {
      suppressClickUntilRef.current = performance.now() + 400
      settleReveal(false, gesture.drawerWidth)
    }
  }, [settleReveal])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (performance.now() > suppressClickUntilRef.current) return
    suppressClickUntilRef.current = 0
    event.preventDefault()
    event.stopPropagation()
  }, [])

  useEffect(() => {
    if (!isDrawerOpen || !gestureRef.current) return
    abandonGesture(gestureRef.current)
    drawerX.set(0)
    scrimOpacity.set(1)
    setIsRevealing(false)
  }, [abandonGesture, drawerX, isDrawerOpen, scrimOpacity])

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < OVERLAY_BREAKPOINT) return
      const gesture = gestureRef.current
      if (gesture) abandonGesture(gesture)
      stopSettleAnimations()
      drawerX.set(-estimateDrawerWidth())
      scrimOpacity.set(0)
      setIsRevealing(false)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [abandonGesture, drawerX, scrimOpacity, stopSettleAnimations])

  useEffect(() => () => {
    const gesture = gestureRef.current
    if (gesture?.measureFrame != null) window.cancelAnimationFrame(gesture.measureFrame)
    stopSettleAnimations()
  }, [stopSettleAnimations])

  return {
    drawerX,
    scrimOpacity,
    isRevealing,
    swipeHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onClickCapture,
    },
  }
}
