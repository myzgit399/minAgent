import { atom } from 'nanostores'

/**
 * Browser history - tracks visited web pages as tabs in the browser pane
 */

export interface BrowserHistoryEntry {
  id: string
  url: string
  title?: string
  timestamp: number
}

const STORAGE_KEY = 'hermes.desktop.browserHistory.v1'
const MAX_ENTRIES = 100

function readHistory(): BrowserHistoryEntry[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e: any) => e && typeof e.url === 'string').slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}

export const $browserHistory = atom<BrowserHistoryEntry[]>(readHistory())

function persist(entries: BrowserHistoryEntry[]): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    }
  } catch {
    // storage full or unavailable
  }
}

let entrySeq = 0

export function addToHistory(url: string, title?: string): string {
  const entries = $browserHistory.get()
  const newEntry: BrowserHistoryEntry = {
    id: `bh-${Date.now().toString(36)}-${(entrySeq += 1)}`,
    url,
    title: title || url,
    timestamp: Date.now()
  }
  
  // Remove duplicate URL if exists
  const filtered = entries.filter(e => e.url !== url)
  const next = [newEntry, ...filtered].slice(0, MAX_ENTRIES)
  
  $browserHistory.set(next)
  persist(next)
  
  return newEntry.id
}

export function removeHistoryEntry(id: string): void {
  const entries = $browserHistory.get().filter(e => e.id !== id)
  $browserHistory.set(entries)
  persist(entries)
}

export function clearHistory(): void {
  $browserHistory.set([])
  persist([])
}

export function getHistoryEntries(limit?: number): BrowserHistoryEntry[] {
  return $browserHistory.get().slice(0, limit)
}
