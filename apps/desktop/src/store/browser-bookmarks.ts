import { atom } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'

/**
 * Browser bookmarks — the address bar's star.
 *
 * Kept separate from the tabs and from the address ring: a bookmark outlives
 * the tab it was made in, and unlike history it is an explicit "keep this",
 * so it is never evicted by a cap or reordered by navigation.
 *
 * Identity is the normalized href (`bookmarkKey`): `https://x.dev/` and
 * `https://x.dev` are one bookmark, while a different query string is another
 * — the same rule a real browser's star follows.
 */
const STORAGE_KEY = 'hermes.desktop.browserBookmarks.v1'

export interface BrowserBookmark {
  addedAt: number
  title: string
  url: string
}

function load(): BrowserBookmark[] {
  const parsed = readJson<unknown>(STORAGE_KEY)

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed.filter((entry): entry is BrowserBookmark => {
    if (!entry || typeof entry !== 'object') {
      return false
    }

    const row = entry as Partial<BrowserBookmark>

    return typeof row.url === 'string' && row.url.trim().length > 0
  })
}

export const $browserBookmarks = atom<BrowserBookmark[]>(load())

function persist(entries: BrowserBookmark[]) {
  $browserBookmarks.set(entries)
  writeJson(STORAGE_KEY, entries)
}

/** URL identity for the star: one trailing slash and the case of the scheme
 *  and host do not make a second bookmark. */
export function bookmarkKey(url: string): string {
  const raw = url.trim()

  if (!raw) {
    return ''
  }

  try {
    const parsed = new URL(raw)
    // One trailing slash never makes a second page: `/`, `/a/` and `/a` are
    // the same address to every browser's star.
    const path = parsed.pathname.replace(/\/$/, '')

    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`
  } catch {
    return raw
  }
}

/** What to call a page we only know by address. */
export function bookmarkTitleFor(url: string, title?: null | string): string {
  const trimmed = title?.trim()

  if (trimmed) {
    return trimmed
  }

  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function isBookmarked(bookmarks: readonly BrowserBookmark[], url: string): boolean {
  const key = bookmarkKey(url)

  return Boolean(key) && bookmarks.some(entry => bookmarkKey(entry.url) === key)
}

/** Star / un-star `url`. Returns whether it is now bookmarked. */
export function toggleBrowserBookmark(url: string, title?: null | string): boolean {
  const key = bookmarkKey(url)

  if (!key) {
    return false
  }

  const current = $browserBookmarks.get()
  const existing = current.find(entry => bookmarkKey(entry.url) === key)

  if (existing) {
    persist(current.filter(entry => entry !== existing))

    return false
  }

  persist([{ addedAt: Date.now(), title: bookmarkTitleFor(url, title), url: url.trim() }, ...current])

  return true
}

export function removeBrowserBookmark(url: string): void {
  const key = bookmarkKey(url)

  if (!key) {
    return
  }

  const current = $browserBookmarks.get()
  const next = current.filter(entry => bookmarkKey(entry.url) !== key)

  if (next.length !== current.length) {
    persist(next)
  }
}

/** Keep a new page title without moving the bookmark in the list. */
export function renameBrowserBookmark(url: string, title: string): void {
  const key = bookmarkKey(url)
  const name = title.trim()

  if (!key || !name) {
    return
  }

  const current = $browserBookmarks.get()

  if (!current.some(entry => bookmarkKey(entry.url) === key && entry.title !== name)) {
    return
  }

  persist(current.map(entry => (bookmarkKey(entry.url) === key ? { ...entry, title: name } : entry)))
}

export function clearBrowserBookmarks(): void {
  persist([])
}
