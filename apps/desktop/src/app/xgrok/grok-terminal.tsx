import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

// xterm host. Grok's TUI paints its own truecolor background, but the canvas
// surface must match so the DOM renderer (WebGL fallback) can't disagree.
const HOST_CLASS =
  'h-full w-full min-h-0 overflow-hidden bg-[#141414] [&_.xterm]:h-full [&_.xterm-screen]:bg-[#141414]! [&_.xterm-viewport]:bg-[#141414]! [&_.xterm-viewport]:scrollbar-width-none [&_.xterm-viewport::-webkit-scrollbar]:hidden'

const TERMINAL_THEME = {
  background: '#141414',
  foreground: '#e1e1e1',
  cursor: '#e1e1e1',
  cursorAccent: '#141414',
  selectionBackground: '#264f78',
  black: '#141414',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#f5f543',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#e1e1e1',
  brightBlack: '#6c6c6c',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

type CatalogModel = {
  id: string
  label: string
  group: string
  groupLabel: string
  mappedTo?: string
  baseUrl?: string
  ready?: boolean
  blockedBy?: string
  proxyEnabled: boolean
}
type CatalogGroup = { id: string; label: string; models: CatalogModel[] }

interface GrokTerminalProps {
  tabId: string
  cwd: string
  model: string
  effort: string
  active: boolean
  /** True when opened via 编程 → + xGrok: first launch starts a new empty session. */
  freshSession?: boolean
  onModelChange: (model: string) => void
}

type Status = 'starting' | 'open' | 'closed'

/**
 * A full, interactive Grok Build TUI running in a real PTY, with a model
 * picker docked at the right end of the CLI composer. Grouping mirrors
 * minAgent's provider groups; the per-model proxy toggle writes back to
 * minAgent's model_proxy policy. Model switches are injected into the live
 * TUI (`/model`) unless the proxy route changed, in which case the PTY is
 * restarted with the new proxy env.
 */
export function GrokTerminal({ tabId, cwd, model, effort, active, freshSession, onModelChange }: GrokTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const disposedRef = useRef(false)
  // Latest values for the (re)start function, kept in refs so changing them
  // never re-mounts the xterm or tears down the PTY.
  const launchRef = useRef({ tabId, cwd, model, effort })
  const startPtyRef = useRef<(model: string, proxyUrl: string) => void>(() => {})
  // Monotonic token: only the newest start() is allowed to commit its session
  // id. A stale start resolving after a newer one must not hijack input.
  const startSeqRef = useRef(0)
  const [status, setStatus] = useState<Status>('starting')
  const [error, setError] = useState('')

  const [groups, setGroups] = useState<CatalogGroup[]>([])
  const [proxyUrl, setProxyUrl] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  launchRef.current = { tabId, cwd, model, effort }

  // Notice is a transient toast — never park it on the composer line.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  // The picker is a transient popover: dismiss it on any outside pointer down
  // (including the terminal surface) or on Escape. Clicks inside the dock are
  // ignored here so the pill toggle, search field and rows keep working.
  useEffect(() => {
    if (!menuOpen) {
      return
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null

      if (dockRef.current && target && !dockRef.current.contains(target)) {
        setMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  const loadCatalog = useCallback(async () => {
    const api = window.hermesDesktop
    if (!api?.xgrokModelCatalog) return
    try {
      const catalog = await api.xgrokModelCatalog()
      setGroups(catalog.groups || [])
      setProxyUrl(catalog.proxyUrl || '')
    } catch {
      // Catalog is a convenience; the TUI itself still works without it.
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  // Mount xterm once; own the PTY lifecycle for this tab.
  useEffect(() => {
    const host = hostRef.current
    const api = window.hermesDesktop

    if (!host || !api?.xgrokPtyStart) {
      setStatus('closed')
      setError('当前宿主不支持嵌入式 Grok TUI（xgrokPtyStart 不可用）。')

      return
    }

    disposedRef.current = false
    const unsubs: Array<() => void> = []
    // Consumed by the first startPty() call only; later restarts use -c.
    let firstLaunchPending = true

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      // PTY output is a raw TTY byte stream (grok paints a full-screen TUI with
      // cursor moves). Converting \n→\r\n here corrupts its layout and leaves
      // stale rows that never repaint — leave the stream untouched.
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, Consolas, "DejaVu Sans Mono", "Microsoft YaHei Mono", monospace',
      fontSize: 12,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.15,
      scrollback: 8000,
      theme: TERMINAL_THEME
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    const fitAndResize = () => {
      if (disposedRef.current || !host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
        return
      }
      try {
        fit.fit()
      } catch {
        return
      }
      const sid = sessionIdRef.current
      if (sid) void api.xgrokPtyResize(sid, { cols: term.cols, rows: term.rows })
    }
    fitRef.current = fitAndResize

    let pendingFrame = 0
    const scheduleResize = () => {
      if (pendingFrame) return
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = 0
        if (!disposedRef.current) fitAndResize()
      })
    }
    const resizeObserver = new ResizeObserver(scheduleResize)
    resizeObserver.observe(host)

    const dataDisposable = term.onData(data => {
      const sid = sessionIdRef.current

      // Sending a prompt while scrolled back would run the turn below the
      // viewport, so the reply (and any tool/edit output) looked like it never
      // arrived. Jump to the live edge on submit; free scrolling otherwise.
      if (data.includes('\r') && term.buffer.active.viewportY < term.buffer.active.baseY) {
        term.scrollToBottom()
      }

      if (sid) {
        void api.xgrokPtyWrite(sid, data)
      }
    })

    unsubs.push(() => dataDisposable.dispose())
    // Only a real key press dismisses the picker. onData also carries the TUI's
    // mouse-report sequences, so using it here closed the menu on mouse move.
    const keyDisposable = term.onKey(() => setMenuOpen(false))
    unsubs.push(() => keyDisposable.dispose())
    // Grok's TUI wraps each repaint in DEC synchronized-output frames
    // (CSI ?2026h ... CSI ?2026l). xterm 6.0 buffers everything between the
    // two and only paints on the terminator. During streaming replies grok can
    // hold a frame open while it keeps pushing text, so the screen freezes with
    // only the first few lines — the exact "content stops growing" symptom.
    // Strip those markers so every chunk paints immediately, preserving ALL of
    // grok's own content, cursor moves and colours (its original look).
    // Build regexes from a variable so ESLint's no-control-regex stays quiet.
    const esc = String.fromCharCode(27)
    const syncFrame = new RegExp(`${esc}\\[\\?2026[hl]`, 'g')
    // DECSCUSR (CSI Ps SP q): normalize grok's block caret (Ps 0/1/2) to a
    // steady bar (Ps 6).
    const decscusrBlock = new RegExp(`${esc}\\[[0-2]\\s?q`, 'g')
    const steadyBar = `${esc}[6 q`
    // xterm owns the parser buffering for any CSI split across chunks, so we
    // only strip the complete frame markers (grok emits h/l together) and leave
    // every one of grok's absolute-position/colour sequences untouched.
    const normalizePtyStream = (chunk: string): string => chunk.replace(syncFrame, '').replace(decscusrBlock, steadyBar)
    unsubs.push(
      api.onXGrokPtyData(tabId, data => {
        if (!disposedRef.current) {
          const out = normalizePtyStream(data)

          if (out) {
            term.write(out)
          }
        }
      })
    )
    unsubs.push(
      api.onXGrokPtyExit(tabId, payload => {
        if (disposedRef.current) return
        // Ignore a late exit from a superseded session (e.g. a just-restarted
        // PTY disposing its predecessor). Only the live session counts.
        if (payload?.sessionId && payload.sessionId !== sessionIdRef.current) return
        setStatus('closed')
        sessionIdRef.current = null
        term.write(`\r\n\x1b[90m[grok 已退出 code=${payload.code} signal=${payload.signal ?? 'none'}]\x1b[0m\r\n`)
      })
    )

    term.open(host)
    // DOM renderer (default) instead of WebGL: grok's TUI does frequent small
    // repaints, and the WebGL canvas left stale tiles/gray patches that never
    // refreshed. DOM renderer has no such ghosting and is plenty fast here.
    fitAndResize()

    const startPty = (startModel: string, startProxy: string) => {
      const launch = launchRef.current
      const seq = ++startSeqRef.current
      const old = sessionIdRef.current
      sessionIdRef.current = null
      if (old) void api.xgrokPtyDispose(old)
      setStatus('starting')
      // Only the very first launch of a + xGrok tab creates a fresh session.
      // Restarts (proxy switch) resume the session just created, so its
      // conversation survives and the user isn't dropped in an empty TUI.
      const asNew = firstLaunchPending && freshSession === true
      firstLaunchPending = false
      void api
        .xgrokPtyStart({
          tabId: launch.tabId,
          cwd: launch.cwd,
          model: startModel,
          effort: launch.effort,
          proxyUrl: startProxy,
          newSession: asNew,
          cols: term.cols,
          rows: term.rows
        })
        .then(res => {
          // A newer start has superseded this one — discard its session.
          if (disposedRef.current || seq !== startSeqRef.current) {
            if (res.id) void api.xgrokPtyDispose(res.id)
            return
          }
          if (!res.ok || !res.id) {
            setStatus('closed')
            const message = res.error || 'grok 启动失败'
            setError(message)
            term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)

            return
          }
          sessionIdRef.current = res.id
          setStatus('open')
          term.focus()
          window.requestAnimationFrame(fitAndResize)
        })
        .catch(err => {
          if (disposedRef.current || seq !== startSeqRef.current) return
          setStatus('closed')
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
        })
    }
    startPtyRef.current = startPty

    // First launch: resolve the initial model's proxy policy from the catalog.
    void api.xgrokModelCatalog().then(catalog => {
      if (disposedRef.current) return
      if (catalog.proxyUrl) setProxyUrl(catalog.proxyUrl)
      const initial = catalog.models.find(m => m.id === launchRef.current.model)
      setProxyUrl(initial?.proxyEnabled ? (catalog.proxyUrl || '') : '')
      startPty(launchRef.current.model, initial?.proxyEnabled ? (catalog.proxyUrl || '') : '')
    })

    return () => {
      disposedRef.current = true
      resizeObserver.disconnect()
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame)
      unsubs.forEach(unsubscribe => unsubscribe())
      const sid = sessionIdRef.current
      if (sid) void api.xgrokPtyDispose(sid)
      sessionIdRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Model/effort changes are handled via switchModel, never by re-mounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    if (!active || status !== 'open') return
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.()
      termRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [active, status])

  const switchTo = useCallback(
    async (target: CatalogModel) => {
      const api = window.hermesDesktop
      const sid = sessionIdRef.current
      if (!sid || busy) return
      setBusy(true)
      setNotice('')
      const targetProxy = target.proxyEnabled ? proxyUrl || '' : ''
      try {
        const res = await api.xgrokPtySwitchModel({ id: sid, model: target.id, proxyUrl: targetProxy })
        if (!res.ok) {
          setNotice(res.error || '切换失败')
          return
        }
        onModelChange(target.id)
        setMenuOpen(false)
        if (res.mode === 'restart') {
          setNotice('代理已变化，正在重连会话…')
          startPtyRef.current(target.id, targetProxy)
        } else {
          setNotice(`已切换到 ${target.label}`)
        }
        termRef.current?.focus()
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [busy, onModelChange, proxyUrl]
  )

  const toggleProxy = useCallback(
    async (target: CatalogModel) => {
      const api = window.hermesDesktop
      const next = !target.proxyEnabled
      // Toggle is always allowed — the flag is stored in the shared minAgent
      // config. If no proxy URL exists there yet, keep the flag but tell the
      // user where to set the address so it actually routes.
      const res = await api.xgrokModelProxy({ provider: target.group, id: target.id, enabled: next })
      if (!res.ok) {
        setNotice(res.error || '代理设置失败')
        return
      }
      // Update local catalog state immediately.
      setGroups(prev =>
        prev.map(g => ({
          ...g,
          models: g.models.map(m => (m.id === target.id && m.group === target.group ? { ...m, proxyEnabled: next } : m))
        }))
      )
      setNotice(
        next && !proxyUrl.trim()
          ? `${target.label} 代理已开启，但需先在 minAgent「设置 → 模型 → 主模型 → 代理地址」填写地址`
          : `${target.label} 代理已${next ? '开启' : '关闭'}`
      )
      // If the toggled model is the active one, re-apply route (restart if needed).
      if (target.id === launchRef.current.model) {
        const activeProxy = next ? proxyUrl || '' : ''
        const sid = sessionIdRef.current
        if (sid) {
          const sw = await api.xgrokPtySwitchModel({ id: sid, model: target.id, proxyUrl: activeProxy })
          if (sw.mode === 'restart') startPtyRef.current(target.id, activeProxy)
        }
      }
      void loadCatalog()
    },
    [loadCatalog, proxyUrl]
  )

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map(g => ({ ...g, models: g.models.filter(m => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)) }))
      .filter(g => g.models.length > 0)
  }, [groups, query])

  const currentModel = groups.flatMap(g => g.models).find(m => m.id === model)

  return (
    <div className={cn('relative flex flex-1 flex-col overflow-hidden', active ? 'visible' : 'invisible pointer-events-none')}>
      {status === 'starting' && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-xs text-(--ui-text-tertiary)">
          正在启动 Grok Build TUI…
        </div>
      )}
      {status === 'closed' && error && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-[#2a1414] px-3 py-1 text-xs text-[#ff9b9b]">
          {error}
        </div>
      )}
      <div className={HOST_CLASS} ref={hostRef} />

      {/* Transient toast at top-right — never overlaps the CLI input line. */}
      {notice && <div className="xgrok-toast">{notice}</div>}

      {/* Model picker docked at the very bottom-right, aligned with grok's own
          "Ctrl+x shortcuts" footer row instead of covering the input box. */}
      <div className="xgrok-model-dock" ref={dockRef}>
        <button
          className={cn('xgrok-model-pill', menuOpen && 'is-open')}
          onClick={() => setMenuOpen(v => !v)}
          title="切换后台模型（按服务分组）"
          type="button"
        >
          <Codicon name="chip" />
          <span>{currentModel?.label || model}</span>
          {currentModel?.proxyEnabled && <Codicon name="globe" />}
          <Codicon name="chevron-down" />
        </button>

        {menuOpen && (
          <div className="xgrok-model-menu">
            <div className="xgrok-model-search">
              <Codicon name="search" />
              <input
                autoFocus
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索模型…"
                value={query}
              />
              <button onClick={() => { void loadCatalog() }} title="刷新模型（同步 minAgent 配置）" type="button">
                <Codicon name="refresh" />
              </button>
            </div>
            <div className="xgrok-model-list">
              {filteredGroups.map(group => (
                <div className="xgrok-model-group" key={group.id}>
                  <div className="xgrok-model-group-title">{group.label}</div>
                  {group.models.map(m => (
                    <div
                      className={cn('xgrok-model-row', m.id === model && 'is-active')}
                      key={`${m.group}::${m.id}`}
                    >
                      <button
                        className="xgrok-model-select"
                        disabled={busy || m.ready === false}
                        onClick={() => void switchTo(m)}
                        title={m.ready === false ? (m.blockedBy || '未配置凭据') : (m.mappedTo ? `→ ${m.mappedTo}` : m.baseUrl)}
                        type="button"
                      >
                        <Codicon name={m.id === model ? 'check' : 'circle-outline'} />
                        <span className="xgrok-model-name">{m.label}</span>
                        <span className="xgrok-model-id">{m.id}</span>
                      </button>
                      <button
                        aria-label="代理"
                        aria-checked={m.proxyEnabled}
                        className={cn('xgrok-model-proxy', m.proxyEnabled && 'is-on')}
                        onClick={() => void toggleProxy(m)}
                        role="switch"
                        title={
                          m.proxyEnabled
                            ? `代理已开启 → ${proxyUrl || '未配置'}（地址来自 minAgent 设置 → 模型 → 代理）`
                            : `点击为该模型开启代理（地址来自 minAgent 设置 → 模型 → 代理${proxyUrl ? `：${proxyUrl}` : '，当前未配置'}）`
                        }
                        type="button"
                      >
                        <Codicon name={m.proxyEnabled ? 'globe' : 'circle-slash'} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {filteredGroups.length === 0 && (
                <div className="xgrok-model-empty">没有匹配的模型。请先在 minAgent 配置模型，或点击刷新。</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
