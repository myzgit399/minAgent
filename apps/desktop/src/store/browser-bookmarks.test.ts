import { beforeEach, describe, expect, it } from 'vitest'

import {
  $browserBookmarks,
  bookmarkKey,
  bookmarkTitleFor,
  clearBrowserBookmarks,
  isBookmarked,
  removeBrowserBookmark,
  renameBrowserBookmark,
  toggleBrowserBookmark
} from './browser-bookmarks'

describe('browser bookmarks', () => {
  beforeEach(() => {
    clearBrowserBookmarks()
    window.localStorage.clear()
    $browserBookmarks.set([])
  })

  it('stars and un-stars a page', () => {
    expect(toggleBrowserBookmark('https://example.com/docs', 'Docs')).toBe(true)
    expect(isBookmarked($browserBookmarks.get(), 'https://example.com/docs')).toBe(true)

    expect(toggleBrowserBookmark('https://example.com/docs')).toBe(false)
    expect($browserBookmarks.get()).toHaveLength(0)
  })

  it('treats a trailing slash and host case as the same page', () => {
    toggleBrowserBookmark('https://Example.com/')

    expect(isBookmarked($browserBookmarks.get(), 'https://example.com')).toBe(true)
    expect(bookmarkKey('https://Example.com/')).toBe(bookmarkKey('https://example.com'))
  })

  it('keeps a different query string as its own bookmark', () => {
    toggleBrowserBookmark('https://example.com/search?q=a', 'A')
    toggleBrowserBookmark('https://example.com/search?q=b', 'B')

    expect($browserBookmarks.get()).toHaveLength(2)
  })

  it('falls back to the host for a page with no title', () => {
    toggleBrowserBookmark('https://news.ycombinator.com/item?id=1')

    expect($browserBookmarks.get()[0].title).toBe('news.ycombinator.com')
    expect(bookmarkTitleFor('https://news.ycombinator.com', '   ')).toBe('news.ycombinator.com')
  })

  it('removes by normalized href and keeps the rest', () => {
    toggleBrowserBookmark('https://example.com/a')
    toggleBrowserBookmark('https://example.com/b')

    removeBrowserBookmark('https://example.com/a/')

    expect($browserBookmarks.get().map(entry => entry.url)).toEqual(['https://example.com/b'])
  })

  it('renames without reordering', () => {
    toggleBrowserBookmark('https://example.com/a', 'Old')
    toggleBrowserBookmark('https://example.com/b', 'B')

    const orderBefore = $browserBookmarks.get().map(entry => entry.url)

    renameBrowserBookmark('https://example.com/a', 'New')

    expect($browserBookmarks.get().map(entry => entry.url)).toEqual(orderBefore)
    expect($browserBookmarks.get().find(entry => entry.url.endsWith('/a'))?.title).toBe('New')
  })

  it('ignores a blank href', () => {
    expect(toggleBrowserBookmark('   ')).toBe(false)
    expect($browserBookmarks.get()).toHaveLength(0)
  })
})
