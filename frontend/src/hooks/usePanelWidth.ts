import { useState } from 'react'
import { readJson, writeJson } from '../lib/storage'

/** Pointer capture keeps resizing local; keyboard users get the same range. */
export function usePanelWidth(key: string, fallback: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const value = readJson<unknown>(key, fallback)
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  })
  const update = (value: number) => {
    const next = Math.max(min, Math.min(max, value))
    setWidth(next)
    writeJson(key, next)
  }
  return { width, update, min, max }
}

