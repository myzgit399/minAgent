/**
 * The tab strip's 网页 control — the text button that replaced the Browser
 * globe glyph. It opens the browser menu: "新网页" mints a blank Browser tab,
 * and below it the addresses you have visited this profile. A history row
 * fronts that page in the Browser tab you are looking at (a fresh tab when
 * none is open); right-clicking it offers "在新tab中打开", which is the
 * deliberate departure — a second tab beside this one.
 */

import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  dropdownMenuRow
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $browserAddressHistory, clearBrowserAddressHistory } from '@/store/browser-address-history'
import { newBrowserTab, openBrowserLinkInNewTab, openPreview } from '@/store/preview'

interface HistoryMenu {
  url: string
  x: number
  y: number
}

export function WebMenu(): ReactNode {
  const { t } = useI18n()
  const history = useStore($browserAddressHistory)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<null | HistoryMenu>(null)

  // Default verb: the address replaces the page in the Browser you are looking
  // at — `openPreview` reuses the visible Browser tab, minting one only when
  // no Browser is open at all.
  const openHere = (url: string) => openPreview({ kind: 'url', label: url, source: url, url })

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={next => {
          setOpen(next)

          if (!next) {
            setMenu(null)
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            aria-label={t.common.web}
            className="flex shrink-0 items-center gap-1 self-center rounded px-1.5 py-0.5 text-xs opacity-60 select-none hover:bg-muted/60 hover:opacity-100 [-webkit-app-region:no-drag]"
            onPointerDown={event => event.stopPropagation()}
            title={t.common.web}
            type="button"
          >
            <Codicon name="globe" size="0.8125rem" />
            <span className="hidden sm:inline">{t.common.web}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => newBrowserTab()}>
            <Codicon name="add" size="0.8125rem" />
            <span className="truncate">{t.common.newWebPage}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {history.length === 0 ? (
            <div className="px-2.5 py-1 text-xs text-muted-foreground">{t.common.noBrowseHistory}</div>
          ) : (
            history.map(url => (
              <DropdownMenuItem
                className={cn(dropdownMenuRow, 'min-w-0')}
                key={url}
                onContextMenu={event => {
                  event.preventDefault()
                  setMenu({ url, x: event.clientX, y: event.clientY })
                }}
                onSelect={() => openHere(url)}
              >
                <span className="truncate" title={url}>
                  {url}
                </span>
              </DropdownMenuItem>
            ))
          )}
          {history.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className={dropdownMenuRow} onSelect={() => clearBrowserAddressHistory()}>
                <Codicon name="trash" size="0.8125rem" />
                <span className="truncate">{t.common.clearAll}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The history row's own right-click menu. A plain fixed layer rather
          than the app-wide menu: the gesture belongs to the row, and the row
          lives inside a popup that closes on outside click — one item, one
          anchor, no target resolution. */}
      {menu ? (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setMenu(null)}
            onContextMenu={event => {
              event.preventDefault()
              setMenu(null)
            }}
            role="presentation"
          />
          <div
            className="fixed z-50 min-w-44 rounded-md border border-border/60 bg-background py-1 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className={cn(dropdownMenuRow, 'flex w-full items-center text-left hover:bg-muted/70')}
              onClick={() => {
                openBrowserLinkInNewTab(menu.url)
                setMenu(null)
                setOpen(false)
              }}
              type="button"
            >
              <Codicon name="link-external" size="0.8125rem" />
              <span className="truncate">{t.common.openInNewTab}</span>
            </button>
          </div>
        </>
      ) : null}
    </>
  )
}
