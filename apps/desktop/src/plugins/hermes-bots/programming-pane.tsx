/**
 * The 编程 pane: the profile's grok build sessions, one row each, plus the
 * affordance that mints a new one.
 *
 * A row is a REVEAL, not a re-open: the tile's pane is already mirrored into
 * the tree by `watchXGrokTiles` (prefix `xgrok-tile`), so clicking a session
 * fronts that pane — un-minimizes, un-hides, activates in its zone — instead
 * of spawning a second tab for the same conversation.
 */

import { Codicon } from '@hermes/plugin-sdk'
import { useStore } from '@nanostores/react'

import { revealTreePane } from '@/components/pane-shell/tree/store'
import { $xgrokTiles, openXGrokTile } from '@/store/xgrok-tiles'

import { useBots } from './i18n'

/** The mirror's pane-id prefix — keep in step with `watchXGrokTiles`. */
const TILE_PANE_PREFIX = 'xgrok-tile'

export function ProgrammingPane() {
  const b = useBots()
  const c = b.programming
  const tiles = useStore($xgrokTiles)

  const reveal = (tileId: string) => revealTreePane(`${TILE_PANE_PREFIX}:${tileId}`)

  // A fresh tile's pane reaches the tree through the mirror's subscription, so
  // the reveal lands on the next microtask rather than a tree without it.
  const openNew = () => {
    // + xGrok always mints a brand-new empty session. Other entries (reopen
    // from the tile toolbar, restored tabs) keep resuming the last one.
    const tileId = openXGrokTile({ freshSession: true })
    queueMicrotask(() => reveal(tileId))
  }

  return (
    <div className="flex h-full flex-col">
      {/* xGrok IS the new-session button: one click mints another grok window
          and fronts it. The separate 新 grok row duplicated this, so it is
          gone — the tab's own name is the verb. */}
      <button
        type="button"
        className="flex w-full shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-(--ui-control-hover-background)"
        onClick={openNew}
        title={c.entryHint}
      >
        <Codicon name="add" />
        <span className="truncate">xGrok</span>
      </button>

      <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs font-medium text-(--ui-text-tertiary)">
        <Codicon name="folder" />
        {c.projects}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tiles.length > 0 ? (
          tiles.map(tile => (
            <button
              key={tile.id}
              type="button"
              title={tile.cwd || tile.title}
              className="block w-full truncate px-3 py-2 text-left text-sm transition-colors hover:bg-(--ui-row-hover-background)"
              onClick={() => reveal(tile.id)}
            >
              {tile.title}
            </button>
          ))
        ) : (
          <div className="px-3 py-4 text-sm text-(--ui-text-tertiary)">{c.empty}</div>
        )}
      </div>
    </div>
  )
}
