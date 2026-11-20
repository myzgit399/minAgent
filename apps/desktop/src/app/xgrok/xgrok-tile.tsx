/**
 * XGROK TILE — the full Grok Build TUI as a first-class minAgent tab.
 *
 * Clicking the sidebar's xGrok entry opens a pane at the end of the workspace
 * strip. The pane runs the real `grok` binary in a pseudo-terminal and renders
 * it with xterm, so it has complete feature parity with standalone `grok` —
 * tools, approvals, slash commands, plan mode, subagents, history and true
 * color — byte-for-byte, instead of the headless turn subset the in-process
 * FFI engine exposed. The tab's model / cwd config seeds the launch flags;
 * everything else is driven by Grok's own TUI.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'

import { paneMirror } from '../chat/pane-mirror'
import { GrokTerminal } from './grok-terminal'

import {
  $xgrokTiles,
  closeXGrokTile,
  getXGrokTile,
  openXGrokTile,
  patchXGrokTile,
  type XGrokTile
} from '@/store/xgrok-tiles'

const DEFAULT_MODEL = 'deepseek-flash'

export function XGrokTilePane({ tileId }: { tileId: string }) {
  const tiles = useStore($xgrokTiles)
  const tile = tiles.find(t => t.id === tileId)
  const [available, setAvailable] = useState(true)
  const [exe, setExe] = useState<{ exe: string; bundled: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const api = window.hermesDesktop
      if (!api?.xgrokPtyAvailable) {
        if (alive) setAvailable(false)
        return
      }
      const ok = Boolean(await api.xgrokPtyAvailable())
      if (!alive) return
      setAvailable(ok)
      if (ok) setExe(await api.xgrokPtyExe())
    })()

    return () => {
      alive = false
    }
  }, [])

  if (!tile) return null

  const model = tile.model || DEFAULT_MODEL

  return (
    <div className="xgrok-root">
      <div className="xgrok-topbar">
        <span className="xgrok-title">
          <Codicon name="terminal" /> {tile.title}
        </span>
        <span className="xgrok-badge">Grok Build TUI · 完整功能</span>
        <span className="xgrok-model" title={exe?.exe || ''}>
          {model}
        </span>
        <span className="xgrok-spacer" />
        <Tip label="重新打开（切换模型/目录后生效）">
          <button className="xgrok-icon-btn" onClick={() => openXGrokTile({ cwd: tile.cwd, model: tile.model })}>
            <Codicon name="add" />
          </button>
        </Tip>
      </div>

      {!available && (
        <div className="xgrok-warning">
          未找到 <code>grok</code> 可执行文件。请先安装 Grok Build（<code>~/.grok/bin/grok.exe</code>），或使用内置 grok 副本重新构建应用。
        </div>
      )}

      {available && (
        <GrokTerminal
          active
          tabId={tile.id}
          cwd={tile.cwd}
          model={model}
          effort={tile.effort}
          freshSession={tile.freshSession}
          onModelChange={next => patchXGrokTile(tile.id, { model: next })}
        />
      )}
    </div>
  )
}

/** Keep panes mirroring `$xgrokTiles`; docked as a tab at the end of the strip. */
export const watchXGrokTiles = paneMirror<XGrokTile>({
  source: $xgrokTiles,
  key: t => t.id,
  prefix: 'xgrok-tile',
  dir: () => 'center',
  anchor: () => 'workspace',
  before: () => undefined,
  minWidth: '24rem',
  title: t => getXGrokTile(t)?.title ?? 'grok',
  render: id => <XGrokTilePane tileId={id} />,
  lifecycleKeepAlive: () => true,
  close: closeXGrokTile
})
