/**
 * 网页 pane — the address bar and the history for the in-app Browser.
 *
 * A column, not a menu: the tab sits beside 编程 in the strip and holds the
 * one text field you type an address into, plus the addresses this profile has
 * already visited. Enter (or Go) mints a Browser tab in the workspace and
 * fronts it; a history row does the same with its own address, so a click never
 * silently re-targets the page you were reading.
 */

import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { revealTreePane } from '@/components/pane-shell/tree/store'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $browserAddressHistory, clearBrowserAddressHistory, recordBrowserAddress } from '@/store/browser-address-history'
import { newBrowserTab, openBrowserLinkInNewTab } from '@/store/preview'
import { PREVIEW_TILE_PREFIX } from '@/store/preview-explicit'

import { normalizePreviewAddress } from '../chat/right-rail/preview-browser-bar'

/** Front the pane the preview mirror is about to create for `tabId`. */
function focusBrowserTab(tabId: null | string | undefined) {
  if (!tabId) {
    return
  }

  queueMicrotask(() => revealTreePane(`${PREVIEW_TILE_PREFIX}:${tabId}`))
}

export function WebPane() {
  const { t } = useI18n()
  const copy = t.preview.web
  const history = useStore($browserAddressHistory)
  const [draft, setDraft] = useState('')

  const open = (raw: string) => {
    const address = normalizePreviewAddress(raw)

    // A blank field is still a page request: a fresh, empty Browser.
    if (!address) {
      focusBrowserTab(newBrowserTab())
      setDraft('')

      return
    }

    recordBrowserAddress(address)
    focusBrowserTab(openBrowserLinkInNewTab(address))
    setDraft('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
        <Input
          aria-label={copy.address}
          className="min-w-0 flex-1"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
              return
            }

            event.preventDefault()
            open(draft)
          }}
          placeholder={copy.addressPlaceholder}
          size="xs"
          spellCheck={false}
          value={draft}
        />
        <button
          className={cn(
            'shrink-0 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-xs font-medium',
            'text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground'
          )}
          onClick={() => open(draft)}
          type="button"
        >
          Go
        </button>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-1 border-t border-(--ui-stroke-secondary) px-2 py-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-(--ui-text-tertiary)">
          <Codicon name="history" />
          {t.recency.browserHistory}
        </span>
        {history.length > 0 && (
          <Tip label={t.common.clearAll}>
            <button
              aria-label={t.common.clearAll}
              className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
              onClick={() => clearBrowserAddressHistory()}
              type="button"
            >
              <Codicon name="trash" size="0.75rem" />
            </button>
          </Tip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="px-3 py-3 text-xs text-(--ui-text-tertiary)">{t.common.noBrowseHistory}</div>
        ) : (
          history.map(url => (
            <button
              className="block w-full truncate px-3 py-1.5 text-left text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-foreground"
              key={url}
              onClick={() => focusBrowserTab(openBrowserLinkInNewTab(url))}
              title={url}
              type="button"
            >
              {url}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
