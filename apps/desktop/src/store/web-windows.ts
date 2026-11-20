/**
 * Web Windows — empty browser tabs for the "网页" sidebar entry.
 *
 * Each window is a standalone browser tab with a URL input field.
 * Windows are persisted (order + config).
 */

import { atom } from 'nanostores'

export interface WebWindowTile {
  id: string
  title: string
  /** Current URL in the address bar */
  url: string
}

const WINDOWS_KEY = 'hermes.desktop.webWindows.v1'
let windowSeq = 0

function readWindows(): WebWindowTile[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(WINDOWS_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((w: any) => w && typeof w.id === 'string')
      .map((w: any) => ({
        id: w.id,
        title: typeof w.title === 'string' && w.title ? w.title : '网页',
        url: typeof w.url === 'string' ? w.url : ''
      }))
  } catch {
    return []
  }
}

export const $webWindows = atom<WebWindowTile[]>(readWindows())

function persist(tiles: WebWindowTile[]): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(WINDOWS_KEY, JSON.stringify(tiles))
  } catch {
    /* storage full or unavailable: windows still work for this run */
  }
}

function writeWindows(next: WebWindowTile[]): void {
  $webWindows.set(next)
  persist(next)
}

export function openWebWindow(init?: Partial<Omit<WebWindowTile, 'id'>>): string {
  const windows = $webWindows.get()
  const used = new Set(windows.map((w) => w.title))
  let n = 1
  while (used.has(`网页 ${n}`)) n += 1
  const windowTile: WebWindowTile = {
    id: `web-${Date.now().toString(36)}-${(windowSeq += 1)}`,
    title: init?.title || `网页 ${n}`,
    url: init?.url ?? ''
  }
  writeWindows([...windows, windowTile])
  return windowTile.id
}
