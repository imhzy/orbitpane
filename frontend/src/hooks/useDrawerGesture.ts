import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react'
import { animate, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import { haptic } from '../lib/nativeFeedback'

type DrawerMode = 'sessions' | 'create'
/** Which surface the finger landed on, not which way the drawer will travel. */
type GestureOrigin = 'content' | 'layer'
type SettleTarget = 'open' | 'closed'

interface DrawerGestureOptions {
  isDrawerOpen: boolean
  /** Let a reveal start on top of a control; used when no conversation is open. */
  allowActionStarts?: boolean
  setIsDrawerOpen: Dispatch<SetStateAction<boolean>>
  setDrawerMode: Dispatch<SetStateAction<DrawerMode>>
  /** Returns false when closing was deferred, e.g. to a discard confirmation. */
  requestClose: () => boolean
}

interface PointerSample {
  x: number
  time: number
}

interface Gesture {
  pointerId: number
  surface: HTMLElement
  origin: GestureOrigin
  startX: number
  startY: number
  lastX: number
  /** Where the drawer sat when the finger landed. A grab that interrupts an
      animation continues from that point instead of jumping to an edge. */
  startOffset: number
  width: number
  locked: boolean
  samples: PointerSample[]
  measureFrame: number | null
}

const OVERLAY_BREAKPOINT = 1024
const SYSTEM_GESTURE_INSET = 32
const CONTENT_LOCK_DISTANCE = 10
const LAYER_LOCK_DISTANCE = 8
/* Opening asks for a deliberate pull; closing is the cheap direction, so it
   commits after roughly a fifth of the width. Both are measured against the
   position the drawer actually holds, which is what lets a gesture pick up
   an animation midway. */
const OPEN_PROGRESS_THRESHOLD = 0.38
const CLOSE_PROGRESS_THRESHOLD = 0.82
const FLICK_DISTANCE = 18
const FLICK_VELOCITY = 450
const VELOCITY_WINDOW_MS = 120
const SETTLE_SPRING = { type: 'spring' as const, stiffness: 420, damping: 40, mass: 0.82 }
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

/** The rendered element wins: the create pane is full-bleed on phones, so a
    CSS-derived estimate would leave a sliver on screen after closing. */
function measureDrawerWidth() {
  const rendered = document.querySelector<HTMLElement>('.drawer')?.offsetWidth
  if (rendered) return rendered
  const viewportWidth = window.innerWidth
  return viewportWidth <= 768
    ? Math.min(310, viewportWidth * 0.86)
    : Math.min(340, viewportWidth * 0.88)
}

function recordSample(gesture: Gesture, x: number, time: number) {
  gesture.samples.push({ x, time })
  const cutoff = time - VELOCITY_WINDOW_MS
  while (gesture.samples.length > 2 && gesture.samples[1].time < cutoff) {
    gesture.samples.shift()
  }
}

function velocityOf(gesture: Gesture) {
  const first = gesture.samples[0]
  const last = gesture.samples[gesture.samples.length - 1]
  const elapsed = Math.max(last.time - first.time, 1)
  return ((last.x - first.x) / elapsed) * 1000
}

function releasePointer(gesture: Gesture) {
  try {
    if (gesture.surface.hasPointerCapture(gesture.pointerId)) {
      gesture.surface.releasePointerCapture(gesture.pointerId)
    }
  } catch {
    // Older iOS WebKit can throw if it already released capture on pointerup.
  }
}

/**
 * React routes events from portalled overlays through their React-tree
 * ancestors, so a bottom sheet rendered at document.body still reaches the
 * drawer layer's listeners. Anything outside the surface's own subtree belongs
 * to whatever put it there.
 */
function isOwnDescendant(event: ReactPointerEvent<HTMLDivElement>) {
  const target = event.target
  return target instanceof Node && event.currentTarget.contains(target)
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
 * One controller for every millimetre the drawer travels.
 *
 * Reveal, dismiss, the button that toggles it and the spring that settles it
 * all write to a single MotionValue, and any pointer landing on either surface
 * stops whatever animation is running and continues from the drawer's current
 * position. That is what makes the two gestures interruptible and continuous:
 * there is no state in which the drawer is "being opened" and therefore cannot
 * be pushed back, because direction is decided per finger movement rather than
 * by which hook owns the drawer.
 */
export function useDrawerGesture({
  isDrawerOpen,
  allowActionStarts = false,
  setIsDrawerOpen,
  setDrawerMode,
  requestClose,
}: DrawerGestureOptions) {
  const prefersReducedMotion = useReducedMotion()
  const [isOverlay, setIsOverlay] = useState(() => window.innerWidth < OVERLAY_BREAKPOINT)
  const [isDragging, setIsDragging] = useState(false)
  /* Mounting has to lead the opening frame and outlive the closing one, so it
     is tracked separately from the app's open flag. */
  const [isMounted, setIsMounted] = useState(isDrawerOpen)
  if (isDrawerOpen && !isMounted) setIsMounted(true)

  const widthRef = useRef(0)
  if (widthRef.current === 0) widthRef.current = measureDrawerWidth()
  const x = useMotionValue(isDrawerOpen ? 0 : -widthRef.current)

  const isOpenRef = useRef(isDrawerOpen)
  isOpenRef.current = isDrawerOpen
  const isMountedRef = useRef(isMounted)
  isMountedRef.current = isMounted
  const isOverlayRef = useRef(isOverlay)
  isOverlayRef.current = isOverlay

  const gestureRef = useRef<Gesture | null>(null)
  const settleRef = useRef<{ stop: () => void } | null>(null)
  const settleGenerationRef = useRef(0)
  const settleTargetRef = useRef<SettleTarget>(isDrawerOpen ? 'open' : 'closed')
  const suppressClickUntilRef = useRef(0)
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  const scrimOpacity = useTransform(x, value => (
    clamp(1 + value / (widthRef.current || 1), 0, 1)
  ))

  /* The hit region is written from the same value that positions the drawer,
     for the same reason the scrim's opacity is: a layer that spans the app and
     decides on its own whether to swallow taps is one missed frame away from
     bricking the page invisibly. A drawer parked off-screen shades nothing, so
     it catches nothing — whatever the mount flag still believes. */
  const layerPointerEvents = useTransform(scrimOpacity, opacity => (
    opacity > 0.01 ? 'auto' : 'none'
  ))

  const stopSettle = useCallback(() => {
    settleGenerationRef.current += 1
    settleRef.current?.stop()
    settleRef.current = null
  }, [])

  const settle = useCallback((target: SettleTarget) => {
    stopSettle()
    settleTargetRef.current = target
    const generation = settleGenerationRef.current
    const destination = target === 'open' ? 0 : -widthRef.current

    settleRef.current = animate(x, destination, {
      ...(prefersReducedMotion ? { duration: 0 } : SETTLE_SPRING),
      onComplete: () => {
        if (generation !== settleGenerationRef.current) return
        settleRef.current = null
        x.set(destination)
        if (target === 'closed' && !isOpenRef.current) setIsMounted(false)
      },
    })
  }, [prefersReducedMotion, stopSettle, x])

  /** Decide the drawer's resting state after a release, and get it there. */
  const commit = useCallback((shouldOpen: boolean) => {
    if (shouldOpen) {
      if (!isOpenRef.current) {
        haptic('light')
        setIsDrawerOpen(true)
      }
      settle('open')
      return
    }
    if (isOpenRef.current) {
      haptic('light')
      // A dirty create form raises a confirmation and stays open; the drawer
      // then has to visibly return to its origin rather than hang mid-slide.
      if (!requestCloseRef.current()) {
        settle('open')
        return
      }
    }
    settle('closed')
  }, [setIsDrawerOpen, settle])

  /* Taking the pointer halts the spring before the gesture has proved itself,
     so a plain tap during a slide would otherwise leave the drawer parked
     wherever the finger caught it. Anything that ends without a drag hands the
     drawer back to the state the app believes it is in. */
  const restIfInterrupted = useCallback(() => {
    if (gestureRef.current || settleRef.current) return
    const resting = isOpenRef.current ? 0 : -widthRef.current
    if (Math.abs(x.get() - resting) < 0.5) {
      // Taking the pointer killed the spring that would have unmounted the
      // drawer on completion. Nothing is left to animate, so retire it here
      // rather than wait for a callback that is no longer coming.
      if (!isOpenRef.current && isMountedRef.current) setIsMounted(false)
      return
    }
    settle(isOpenRef.current ? 'open' : 'closed')
  }, [settle, x])

  const abandonGesture = useCallback((gesture: Gesture) => {
    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    releasePointer(gesture)
    restIfInterrupted()
  }, [restIfInterrupted])

  const beginGesture = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    origin: GestureOrigin,
  ) => {
    const width = measureDrawerWidth()
    widthRef.current = width
    // A deliberate new touch means the click this gesture eventually produces
    // is wanted; only the release that ends a drag is worth swallowing.
    suppressClickUntilRef.current = 0
    // Taking the pointer stops the spring where it stands, so the drawer is
    // handed to the finger at exactly the position the eye last saw.
    stopSettle()
    const offset = isMountedRef.current ? clamp(x.get(), -width, 0) : -width
    x.set(offset)

    gestureRef.current = {
      pointerId: event.pointerId,
      surface: event.currentTarget,
      origin,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startOffset: offset,
      width,
      locked: false,
      samples: [{ x: event.clientX, time: event.timeStamp }],
      measureFrame: null,
    }
  }, [stopSettle, x])

  const onContentPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== 'touch'
      || !event.isPrimary
      || gestureRef.current
      || isOpenRef.current
      || !isOverlayRef.current
      || document.querySelector('[aria-modal="true"]')
      || event.clientX < (window.visualViewport?.offsetLeft ?? 0) + SYSTEM_GESTURE_INSET
      || !isOwnDescendant(event)
      || gestureBelongsToNestedContent(event.target, event.currentTarget, allowActionStarts)
    ) return

    beginGesture(event, 'content')
  }, [allowActionStarts, beginGesture])

  const onLayerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !event.isPrimary
      || gestureRef.current
      || !isMountedRef.current
      || !isOverlayRef.current
      || (event.pointerType === 'mouse' && event.button !== 0)
    ) return

    // A sheet or confirmation displayed over the drawer owns its own gesture.
    if (!isOwnDescendant(event)) return
    const target = event.target instanceof Element ? event.target : null
    const modal = target?.closest<HTMLElement>('[aria-modal="true"]')
    if (modal && !modal.classList.contains('drawer')) return

    beginGesture(event, 'layer')
  }, [beginGesture])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY
    const absoluteX = Math.abs(deltaX)
    const absoluteY = Math.abs(deltaY)

    if (!gesture.locked) {
      if (gesture.origin === 'content') {
        if (
          deltaX < -CONTENT_LOCK_DISTANCE
          || (absoluteY >= CONTENT_LOCK_DISTANCE && absoluteY > absoluteX)
        ) {
          abandonGesture(gesture)
          return
        }
        if (deltaX < CONTENT_LOCK_DISTANCE || deltaX <= absoluteY * 1.2) return

        setDrawerMode('sessions')
        setIsMounted(true)
        isMountedRef.current = true

        // The estimate matches the CSS and makes the first frame immediate.
        // Once React mounts the drawer, measure it so a width the CSS changed
        // does not make the last pixels drift away from the finger.
        gesture.measureFrame = window.requestAnimationFrame(() => {
          gesture.measureFrame = null
          if (gestureRef.current !== gesture) return
          const rendered = document.querySelector<HTMLElement>('.drawer')?.offsetWidth
          if (!rendered || rendered === gesture.width) return
          if (gesture.startOffset <= -gesture.width) gesture.startOffset = -rendered
          gesture.width = rendered
          widthRef.current = rendered
          x.set(clamp(gesture.startOffset + (gesture.lastX - gesture.startX), -rendered, 0))
        })
      } else {
        if (absoluteX < LAYER_LOCK_DISTANCE && absoluteY < LAYER_LOCK_DISTANCE) return
        // A vertical drag scrolls the pane under the finger.
        if (absoluteY >= absoluteX) {
          abandonGesture(gesture)
          return
        }
        // Rightward on an already-open drawer has nowhere to go, so it is left
        // to whatever nested content wants it. Caught mid-flight it reopens.
        if (deltaX >= 0 && gesture.startOffset >= 0) {
          abandonGesture(gesture)
          return
        }
      }

      gesture.locked = true
      setIsDragging(true)
      try {
        gesture.surface.setPointerCapture(gesture.pointerId)
      } catch {
        // Pointer capture is an enhancement; the surface listeners still run.
      }
    }

    gesture.lastX = event.clientX
    recordSample(gesture, event.clientX, event.timeStamp)
    x.set(clamp(gesture.startOffset + deltaX, -gesture.width, 0))
    if (event.cancelable) event.preventDefault()
  }, [abandonGesture, setDrawerMode, x])

  const finishGesture = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled: boolean,
  ) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    releasePointer(gesture)
    if (!gesture.locked) {
      restIfInterrupted()
      return
    }

    if (!cancelled) {
      gesture.lastX = event.clientX
      recordSample(gesture, event.clientX, event.timeStamp)
      x.set(clamp(gesture.startOffset + (event.clientX - gesture.startX), -gesture.width, 0))
    }

    suppressClickUntilRef.current = performance.now() + 500
    setIsDragging(false)
    widthRef.current = gesture.width

    if (cancelled) {
      commit(isOpenRef.current)
      return
    }

    const travel = gesture.lastX - gesture.startX
    const velocity = velocityOf(gesture)
    const progress = clamp((x.get() + gesture.width) / gesture.width, 0, 1)

    if (Math.abs(travel) >= FLICK_DISTANCE && Math.abs(velocity) >= FLICK_VELOCITY) {
      commit(velocity > 0)
      return
    }
    commit(travel < 0
      ? progress > CLOSE_PROGRESS_THRESHOLD
      : progress >= OPEN_PROGRESS_THRESHOLD)
  }, [commit, restIfInterrupted, x])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishGesture(event, false)
  }, [finishGesture])

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishGesture(event, true)
  }, [finishGesture])

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    // Touch pointers start with implicit capture on the element under the
    // finger. Moving capture to the gesture surface first emits
    // lostpointercapture from that child, which bubbles through here. That is
    // a transfer, not the surface losing the gesture — dropping it there used
    // to kill every swipe that began on top of a message row.
    if (event.target !== gesture.surface) return

    gestureRef.current = null
    if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
    if (!gesture.locked) {
      restIfInterrupted()
      return
    }
    suppressClickUntilRef.current = performance.now() + 500
    setIsDragging(false)
    widthRef.current = gesture.width
    commit(isOpenRef.current)
  }, [commit, restIfInterrupted])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (performance.now() > suppressClickUntilRef.current) return
    suppressClickUntilRef.current = 0
    event.preventDefault()
    event.stopPropagation()
  }, [])

  /* The single source of truth for resting position: whatever the app decides
     about `isDrawerOpen` — a button, a shortcut, picking a conversation — is
     played through the same spring the gestures use, so a toggle mid-swipe
     joins the motion already in progress instead of restarting it. */
  useLayoutEffect(() => {
    if (!isOverlay) {
      stopSettle()
      settleTargetRef.current = isDrawerOpen ? 'open' : 'closed'
      x.set(0)
      if (isMounted !== isDrawerOpen) setIsMounted(isDrawerOpen)
      return
    }
    if (gestureRef.current) return

    if (isDrawerOpen) {
      const width = measureDrawerWidth()
      widthRef.current = width
      // A parked drawer may have been measured against a narrower mode than
      // the one it is opening in — the create pane is full-bleed on phones.
      // Re-park it before the opening frame is painted, or it starts with a
      // slice of itself already showing. Mid-flight it is left alone.
      if (!settleRef.current && settleTargetRef.current === 'closed') x.set(-width)
      if (settleTargetRef.current !== 'open') settle('open')
      return
    }
    if (!isMounted) return
    widthRef.current = measureDrawerWidth()
    if (settleTargetRef.current !== 'closed') settle('closed')

    /* The spring's onComplete is the fast path, not the guarantee. It rides on
       a frame callback, and WebKit stops delivering those while the app is
       backgrounded or a system gesture owns the touch — the exit animation
       then never finishes and the drawer stays mounted for the rest of the
       session. Long enough that the spring wins under normal conditions. */
    const retire = window.setTimeout(() => {
      if (!isOpenRef.current && !gestureRef.current) setIsMounted(false)
    }, 700)
    return () => window.clearTimeout(retire)
  }, [isDrawerOpen, isMounted, isOverlay, settle, stopSettle, x])

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${OVERLAY_BREAKPOINT}px)`)
    const sync = () => setIsOverlay(!query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const handleResize = () => {
      const gesture = gestureRef.current
      if (gesture) {
        abandonGesture(gesture)
        setIsDragging(false)
      }
      const width = measureDrawerWidth()
      widthRef.current = width
      // Keep a closed drawer parked exactly off-screen through rotations and
      // the width change the create pane brings with it.
      if (!settleRef.current && settleTargetRef.current === 'closed') x.set(-width)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [abandonGesture, x])

  useEffect(() => () => {
    const gesture = gestureRef.current
    if (gesture) {
      if (gesture.measureFrame !== null) window.cancelAnimationFrame(gesture.measureFrame)
      releasePointer(gesture)
    }
    settleRef.current?.stop()
  }, [])

  return {
    x,
    scrimOpacity,
    layerPointerEvents,
    isDragging,
    /** True while any part of the drawer is on screen, including its exit. */
    isVisible: isMounted,
    contentHandlers: {
      onPointerDown: onContentPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onClickCapture,
    },
    layerHandlers: {
      onPointerDownCapture: onLayerPointerDown,
      onPointerMoveCapture: onPointerMove,
      onPointerUpCapture: onPointerUp,
      onPointerCancelCapture: onPointerCancel,
      onLostPointerCaptureCapture: onLostPointerCapture,
      onClickCapture,
    },
  }
}
