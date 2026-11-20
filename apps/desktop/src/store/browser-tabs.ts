import { atom } from 'nanostores'

/**
 * Browser tabs/windows management - opens URLs in app-integrated browser pane
 */

export interface BrowserTab {
  id: string
  url: string
  title?: string
  isActive: boolean
}

const MAX_TABS = 50

function readTabs(): BrowserTab[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('hermes.desktop.browserTabs.v1') : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t: any) => t && typeof t.url === 'string').slice(0, MAX_TABS)
  } catch {
    return []
  }
}

export const $browserTabs = atom<BrowserTab[]>(readTabs())

function persist(tabs: BrowserTab[]): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('hermes.desktop.browserTabs.v1', JSON.stringify(tabs))
    }
  } catch {
    // storage full or unavailable
  }
}

let tabSeq = 0

export function openBrowserTab(url: string, title?: string): BrowserTab {
  const tabs = $browserTabs.get()
  
  // If URL already has a tab, switch to it
  const existingIndex = tabs.findIndex(t => t.url === url)
  if (existingIndex !== -1) {
    const next = tabs.map((t, i) => ({ ...t, isActive: i === existingIndex }))
    $browserTabs.set(next)
    persist(next)
    return next[existingIndex]
  }
  
  // Close inactive tabs if at limit
  const activeTabs = tabs.filter(t => t.isActive)
  const newTabs = [...tabs.slice(-MAX_TABS + 1), {
    id: `bt-${Date.now().toString(36)}-${(tabSeq += 1)}`,
    url,
    title: title || url,
    isActive: true
  }]
  
  $browserTabs.set(newTabs)
  persist(newTabs)
  
  return newTabs[newTabs.length - 1]
}

export function closeBrowserTab(tabId: string): void {
  const tabs = $browserTabs.get()
  const index = tabs.findIndex(t => t.id === tabId)
  if (index === -1) return
  
  const next = tabs.filter(t => t.id !== tabId)
  // Activate previous tab if current was closed
  if (next.length > 0 && index >= next.length) {
    next[next.length - 1].isActive = true
  }
  
  $browserTabs.set(next)
  persist(next)
}

export function switchToBrowserTab(tabId: string): BrowserTab | undefined {
  const tabs = $browserTabs.get()
  const tab = tabs.find(t => t.id === tabId)
  
  if (!tab) return undefined
  
  const next = tabs.map(t => ({ ...t, isActive: t.id === tabId }))
  $browserTabs.set(next)
  persist(next)
  
  return next[tabs.indexOf(tab)]
}

export function updateBrowserTabUrl(tabId: string, newUrl: string): void {
  const tabs = $browserTabs.get()
  const next = tabs.map(t => 
    t.id === tabId ? { ...t, url: newUrl, title: t.title || newUrl } : t
  )
  $browserTabs.set(next)
  persist(next)
}

export function getActiveBrowserTab(): BrowserTab | undefined {
  return $browserTabs.get().find(t => t.isActive)
}
