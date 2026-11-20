import { atom } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'

/**
 * Browser address history — the address bar's typed-entry ring.
 *
 * Every committed address lands here, newest first and de-duplicated, so the
 * bar can offer it back as quick-fill suggestions. Persisted separately from
 * the tabs: closing a Browser tab should not erase where you have been.
 */
const STORAGE_KEY = 'hermes.desktop.browserAddressHistory.v1'
const MAX_ENTRIES = 20

function load(): string[] {
  const parsed = readJson<unknown>(STORAGE_KEY)

  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

export const $browserAddressHistory = atom<string[]>(load())

function persist(entries: string[]) {
  $browserAddressHistory.set(entries)
  writeJson(STORAGE_KEY, entries)
}

/** Record a committed address. `about:blank` is chrome, not a destination. */
export function recordBrowserAddress(url: string): void {
  const value = url.trim()

  if (!value || value === 'about:blank') {
    return
  }

  const current = $browserAddressHistory.get()
  const next = [value, ...current.filter(entry => entry !== value)].slice(0, MAX_ENTRIES)

  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return
  }

  persist(next)
}

/** The suggestions to show under the current draft, newest first. */
export function browserAddressSuggestions(history: readonly string[], query: string, limit = 8): string[] {
  const needle = query.trim().toLowerCase()

  if (!needle) {
    return history.slice(0, limit)
  }

  return history.filter(entry => entry.toLowerCase().includes(needle)).slice(0, limit)
}

export function clearBrowserAddressHistory(): void {
  persist([])
}
