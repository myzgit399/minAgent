/**
 * BROWSER BAR: back / forward / reload / address / pop-out (or pop-in) for a
 * URL preview.
 *
 * The Browser tab had no way to move: no history, and the only address on
 * screen was a read-only label. Every other embedded browser (VS Code's Simple
 * Browser included) puts those four controls in one row above the page, so this
 * does too — and it sits with the page it drives rather than on the zone strip,
 * which is shared with every other tab.
 *
 * The console / DevTools toggles moved here for the same reason: they act on
 * THIS page, so they belong beside its address, not on the strip where they
 * were ambiguous the moment a second tab opened. They stay `PaneStripGlyph`
 * buttons, so a glyph here and a glyph on the strip are still the same button.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { PaneStripGlyph } from '@/components/ui/pane-tab'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { isSubmitEnter } from '@/lib/ime'
import { ANNOTATE_BLUE } from '@/lib/preview-annotate'
import { cn } from '@/lib/utils'
import {
  $browserAddressHistory,
  browserAddressSuggestions,
  recordBrowserAddress
} from '@/store/browser-address-history'
import {
  $browserBookmarks,
  isBookmarked,
  removeBrowserBookmark,
  toggleBrowserBookmark
} from '@/store/browser-bookmarks'
import { $browserPages } from '@/store/preview'
import { canOpenBrowserWindow, isBrowserWindow } from '@/store/windows'

import { WebMenu } from '@/components/pane-shell/tree/renderer/web-menu'

import { PreviewVaultButton } from './preview-vault-picker'

interface PreviewBrowserBarProps {
  annotateMode?: boolean
  canGoBack: boolean
  canGoForward: boolean
  commentCount?: number
  consoleOpen: boolean
  devToolsOpen: boolean
  loading: boolean
  onBack: () => void
  /** The pane's Close — the one visible way out of a full-width Browser. */
  onClose?: () => void
  onFlushComments?: () => void
  onForward: () => void
  onNavigate: (url: string) => void
  onOpenExternal?: () => void
  onPopIn?: () => void
  onPopOut?: () => void
  onReload: () => void
  onToggleAnnotate?: () => void
  onToggleConsole: () => void
  onToggleDevTools: () => void
  /** Per-tab proxy route; hidden when no proxy URL is configured. */
  onToggleProxy?: () => void
  onUseWpsLogin?: () => void
  proxyEnabled?: boolean
  /** The Browser tab this bar drives; set = offer the saved-login key button. */
  tabId?: string
  /** The page's CURRENT address (it moves as the user navigates), not the
   *  target the tab was opened with. */
  url: string
}

/**
 * What the user typed, as something a webview can load — or `null` if it isn't
 * loadable. A bare host is the common case in an address bar, and here it is
 * usually a dev server, so loopback gets `http` (nothing is listening on 443
 * and there's no certificate) and anything else gets `https`.
 *
 * The blocklist is deliberately narrow: `javascript:` and `data:` execute in
 * the guest partition rather than navigating it, so an address bar is not the
 * place to reach them. Everything a browser normally loads — including
 * `about:blank` and `file://` — goes through, because this IS a browser and
 * the person typing already owns the machine it runs on.
 */
export function normalizePreviewAddress(value: string): null | string {
  const address = value.trim()

  if (!address) {
    return null
  }

  // `://`, not a leading-scheme regex: `localhost:5173` and `example.com:8080`
  // both match `scheme:` and would be read as an unknown protocol instead of a
  // host and a port. `about:blank` has no `://` either, hence the explicit
  // scheme test before the host guess.
  const scheme = /^(about|blob|chrome|data|devtools|file|ftp|https?|javascript|view-source):/i.exec(address)?.[1]
  const loopback = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)
  const candidate = scheme ? address : `${loopback ? 'http' : 'https'}://${address}`

  // Script-bearing schemes run INSIDE the page the user is looking at (or mint
  // a document with an attacker-chosen body) — that's injection wearing a
  // navigation's clothes, and no browser's address bar honors it either.
  if (scheme && /^(data|javascript)$/i.test(scheme)) {
    return null
  }

  try {
    // A parse failure is the real filter for junk: `://broken`, `htp:/x`, and
    // half-typed nonsense all land here.
    new URL(candidate)

    return candidate
  } catch {
    return null
  }
}

export function isWpsLoginAddress(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()

    return host === 'wps.cn' || host === 'kdocs.cn' || host.endsWith('.wps.cn') || host.endsWith('.kdocs.cn')
  } catch {
    return false
  }
}

/** "Open in browser" for a window that can neither pop out nor pop in. */
export function externalOpenerFor(url: string): (() => void) | undefined {
  return !isBrowserWindow() && !canOpenBrowserWindow() ? () => void window.hermesDesktop?.openExternal(url) : undefined
}

export function PreviewBrowserBar({
  annotateMode = false,
  canGoBack,
  canGoForward,
  commentCount = 0,
  consoleOpen,
  devToolsOpen,
  loading,
  onBack,
  onClose,
  onFlushComments,
  onForward,
  onNavigate,
  onOpenExternal,
  onPopIn,
  onPopOut,
  onReload,
  onToggleAnnotate,
  onToggleConsole,
  onToggleDevTools,
  onToggleProxy,
  onUseWpsLogin,
  proxyEnabled,
  tabId,
  url
}: PreviewBrowserBarProps) {
  const { t } = useI18n()
  const copy = t.preview.web
  // Null while the field is idle, so the address tracks navigation on its own;
  // a string once the user takes it over, so typing survives a page load.
  const [draft, setDraft] = useState<null | string>(null)
  // The address we asked for and are still waiting on. Without it, committing
  // dropped the field straight back to `url` — the page you were LEAVING —
  // so every navigation flashed the old address before the new one arrived.
  const [pending, setPending] = useState<null | string>(null)
  // Only while the user is typing: a page that navigates itself is never the
  // user's mistake to flag.
  const invalid = draft !== null && draft.trim().length > 0 && !normalizePreviewAddress(draft)
  // A brand-new Browser tab is still a blank vessel: the pane keeps `about:blank`
  // internally, but the address field reads as "ready for your input", not as if
  // you had already navigated somewhere.
  const shown = draft ?? pending ?? (/^about:blank\/?$/i.test(url) ? '' : url)

  // The page moved (or a redirect landed somewhere else entirely), so the real
  // address supersedes what we asked for.
  useEffect(() => setPending(null), [url])

  const history = useStore($browserAddressHistory)
  const bookmarks = useStore($browserBookmarks)
  const pages = useStore($browserPages)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const historyMatches = useMemo(() => browserAddressSuggestions(history, shown), [history, shown])
  const starred = isBookmarked(bookmarks, url)
  // The guest reports its own document title; a page without one is known by
  // its address, which is what the bookmark then carries.
  const pageTitle = tabId ? pages[tabId]?.title : undefined

  const closeHistory = () => {
    setHistoryOpen(false)
    setHistoryIndex(-1)
  }

  const commit = (value: string) => {
    const address = normalizePreviewAddress(value)

    if (!address) {
      return
    }

    setDraft(null)
    setPending(address)
    closeHistory()
    recordBrowserAddress(address)
    onNavigate(address)
  }

  return (
    <div className="flex min-h-(--titlebar-height) shrink-0 items-center gap-1 border-b border-border/60 bg-background px-1.5 py-1">
      <PaneStripGlyph
        disabled={!canGoBack}
        icon={<Codicon name="arrow-left" size="0.8125rem" />}
        label={copy.goBack}
        onSelect={onBack}
      />
      <PaneStripGlyph
        disabled={!canGoForward}
        icon={<Codicon name="arrow-right" size="0.8125rem" />}
        label={copy.goForward}
        onSelect={onForward}
      />
      <PaneStripGlyph
        icon={<Codicon name="refresh" size="0.8125rem" spinning={loading} />}
        label={copy.reload}
        onSelect={onReload}
      />
      {/* The 网页 menu — new page + this profile's visited addresses — lives
          here, in the Browser tab's own bar, beside the address it drives. */}
      <WebMenu />
      {/* The copy control lives INSIDE the field, on its right edge — the
          same pre-faded inline icon code blocks use, not a toolbar button.
          It copies what the field shows: on a remote gateway, that is the
          reach-resolved address. */}
      <div className="relative min-w-0 flex-1">
        {/* Progress lives IN the field, where the address it belongs to is —
            the reload glyph also spins, but it sits in a row of four and
            reads as chrome rather than as this page's state. */}
        {loading && (
          <Codicon
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            name="loading"
            size="0.75rem"
            spinning
          />
        )}
        <Input
          aria-invalid={invalid || undefined}
          aria-label={copy.address}
          className={cn('pr-7', loading && 'pl-6')}
          inputMode="url"
          onBlur={() => {
            setDraft(null)
            closeHistory()
          }}
          onChange={event => {
            setDraft(event.target.value)
            setHistoryIndex(-1)
            setHistoryOpen(history.length > 0)
          }}
          onFocus={event => {
            setDraft(shown)
            setHistoryIndex(-1)
            setHistoryOpen(history.length > 0)
            event.currentTarget.select()
          }}
          onKeyDown={event => {
            if (historyOpen && historyMatches.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setHistoryIndex(index =>
                event.key === 'ArrowDown'
                  ? Math.min(index + 1, historyMatches.length - 1)
                  : index <= 0 ? -1 : index - 1
              )

              return
            }

            if (isSubmitEnter(event)) {
              const selected = historyOpen && historyIndex >= 0 ? historyMatches[historyIndex] : event.currentTarget.value
              commit(selected ?? '')
              event.currentTarget.blur()
            }

            if (event.key === 'Escape') {
              setDraft(null)
              closeHistory()
              event.currentTarget.blur()
            }
          }}
          placeholder={copy.addressPlaceholder}
          size="xs"
          spellCheck={false}
          value={shown}
        />
        {historyOpen && historyMatches.length > 0 ? (
          <ul
            aria-label={copy.addressHistory ?? copy.address}
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border/60 bg-background py-1 shadow-lg"
            role="listbox"
          >
            {historyMatches.map((entry, index) => (
              <li key={entry}>
                <button
                  aria-selected={index === historyIndex}
                  className={cn(
                    'flex w-full items-center px-2 py-1 text-left text-xs',
                    index === historyIndex ? 'bg-muted' : 'hover:bg-muted/70'
                  )}
                  onClick={() => commit(entry)}
                  onMouseDown={event => event.preventDefault()}
                  role="option"
                  type="button"
                >
                  <span className="block truncate" title={entry}>
                    {entry}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <CopyButton
          appearance="inline"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-1"
          iconClassName="size-3"
          label={t.contextMenu.link.copyUrl}
          showLabel={false}
          text={url}
        />
      </div>
      {tabId ? <PreviewVaultButton tabId={tabId} url={url} /> : null}
      {/* Bookmark star + the saved list. Both act on THIS page, so they sit
          beside the address they describe rather than on the zone strip. */}
      <PaneStripGlyph
        disabled={!url || /^about:blank\/?$/i.test(url)}
        icon={<Codicon name={starred ? 'star-full' : 'star-empty'} size="0.8125rem" />}
        label={
          starred ? (copy.bookmarkRemove ?? 'Remove bookmark') : (copy.bookmarkAdd ?? 'Bookmark this page')
        }
        onSelect={() => toggleBrowserBookmark(url, pageTitle)}
      />
      <div className="relative shrink-0">
        <PaneStripGlyph
          icon={<Codicon name="bookmark" size="0.8125rem" />}
          label={copy.bookmarks ?? 'Bookmarks'}
          onSelect={() => setBookmarksOpen(open => !open)}
        />
        {bookmarksOpen ? (
          <div
            className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-border/60 bg-background py-1 shadow-lg"
            onMouseLeave={() => setBookmarksOpen(false)}
          >
            {bookmarks.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {copy.bookmarksEmpty ?? 'No bookmarks yet — star a page to keep it here.'}
              </p>
            ) : (
              <ul aria-label={copy.bookmarks ?? 'Bookmarks'} className="max-h-72 overflow-y-auto" role="listbox">
                {bookmarks.map(entry => (
                  <li className="group flex items-center gap-1" key={entry.url}>
                    <button
                      className="min-w-0 flex-1 px-2 py-1 text-left text-xs hover:bg-muted/70"
                      onClick={() => {
                        setBookmarksOpen(false)
                        commit(entry.url)
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="block truncate">{entry.title}</span>
                      <span className="block truncate text-[0.62rem] text-muted-foreground">{entry.url}</span>
                    </button>
                    <button
                      aria-label={copy.bookmarkRemove ?? 'Remove bookmark'}
                      className="shrink-0 px-1.5 py-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                      onClick={() => removeBrowserBookmark(entry.url)}
                      title={copy.bookmarkRemove ?? 'Remove bookmark'}
                      type="button"
                    >
                      <Codicon name="close" size="0.75rem" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
      {onUseWpsLogin && isWpsLoginAddress(url) ? (
        <PaneStripGlyph
          icon={<Codicon name="sign-in" size="0.8125rem" />}
          label={copy.useWpsLogin ?? 'Use this WPS login'}
          onSelect={onUseWpsLogin}
        />
      ) : null}
      {onToggleProxy ? (
        // The proxy toggle matches the other toolbar buttons: no visible text
        // label — hovering shows the same Tip everyone else uses, "代理开关".
        <Tip label={copy.proxyToggle ?? 'Proxy toggle'} placement="toolbar">
          <Switch
            aria-label={copy.proxyToggle ?? 'Proxy toggle'}
            checked={Boolean(proxyEnabled)}
            // ON must READ as ON. The shared Switch's checked track is
            // `bg-primary` (a light surface in this theme) and it wins the
            // Tailwind conflict against a same-variant utility, so the state
            // is painted inline — the one channel no variant can outrank.
            style={proxyEnabled ? { backgroundColor: '#2F80ED', borderColor: 'transparent' } : undefined}
            onCheckedChange={onToggleProxy}
            size="xs"
          />
        </Tip>
      ) : null}
      {onToggleAnnotate ? (
        <PaneStripGlyph
          active={annotateMode}
          icon={<Codicon name="comment" size="0.8125rem" />}
          label={annotateMode ? copy.annotateOn : copy.annotate}
          onSelect={onToggleAnnotate}
        />
      ) : null}
      {annotateMode ? (
        <span
          className="hidden shrink-0 items-center rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tracking-wide text-white uppercase sm:inline-flex"
          data-annotate-status="commenting"
          style={{ background: ANNOTATE_BLUE }}
        >
          {copy.commenting}
        </span>
      ) : null}
      {commentCount > 0 && onFlushComments ? (
        <button
          className="shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold text-white"
          onClick={onFlushComments}
          style={{ background: ANNOTATE_BLUE }}
          type="button"
        >
          {copy.addComments(commentCount)}
        </button>
      ) : null}
      {onPopIn ? (
        <PaneStripGlyph
          icon={<Codicon name="screen-normal" size="0.8125rem" />}
          label={t.preview.popIn}
          onSelect={onPopIn}
        />
      ) : onPopOut ? (
        <PaneStripGlyph
          icon={<Codicon name="empty-window" size="0.8125rem" />}
          label={t.preview.popOut}
          onSelect={onPopOut}
        />
      ) : onOpenExternal ? (
        <PaneStripGlyph
          icon={<Codicon name="link-external" size="0.8125rem" />}
          label={t.preview.openInBrowser}
          onSelect={onOpenExternal}
        />
      ) : null}
      <PaneStripGlyph
        active={consoleOpen}
        icon={<Codicon name="terminal" size="0.8125rem" />}
        label={consoleOpen ? copy.hideConsole : copy.showConsole}
        onSelect={onToggleConsole}
      />
      <PaneStripGlyph
        active={devToolsOpen}
        icon={<Codicon name="bug" size="0.8125rem" />}
        label={devToolsOpen ? copy.hideDevTools : copy.openDevTools}
        onSelect={onToggleDevTools}
      />
      {/* The last glyph is the way OUT: a Browser that filled the layout has
          no strip ✕ in reach, and the only other close is asking the agent
          (#92500). Same verb the tab carries — the pane routes it. */}
      {onClose && (
        <PaneStripGlyph icon={<Codicon name="close" size="0.8125rem" />} label={t.common.close} onSelect={onClose} />
      )}
    </div>
  )
}
