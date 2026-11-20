// xGrok PTY host: runs the real `grok` (Grok Build TUI) as a child process in a
// pseudo-terminal and relays its raw ANSI stream to the xGrok tab's xterm. This
// is distinct from xgrok-ipc.ts (the in-process FFI engine, headless turns):
// here the user gets the full interactive TUI — tools, approvals, slash menu,
// plan mode, subagents, history — byte-for-byte identical to standalone grok.
//
// PTY session lifecycle mirrors the embedded terminal (node-pty / ConPTY). We
// keep grok sessions in their own registry so closing a grok tab never touches
// a user shell, and so the grok TUI's own key handling is never intercepted by
// the terminal gateway/ssh routing that `hermes:terminal:*` applies.

import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import nodePty from 'node-pty'

export interface XGrokPtyStartConfig {
  /** Renderer tab that owns this PTY; channels are keyed by it. */
  tabId: string
  /** Working directory for the grok session (falls back to home). */
  cwd?: string
  /** grok model id; empty lets grok use ~/.grok/config.toml default. */
  model?: string
  /** Reasoning effort; empty = model default. */
  effort?: string
  /** Proxy URL for this session's model (exported as HTTPS_PROXY). Empty = direct. */
  proxyUrl?: string
  /** True = force a brand-new empty session (-s); default = resume last (-c). */
  newSession?: boolean
  cols?: number
  rows?: number
}

export interface XGrokPtyStartResult {
  ok: boolean
  error?: string
  id?: string
  exe?: string
  /** True when launched from the app-bundled copy, false from the user's install. */
  bundled?: boolean
}

export interface XGrokPtySwitchResult {
  ok: boolean
  mode?: 'switched' | 'restart'
  error?: string
}

export interface XGrokPtyDeps {
  isWindows: boolean
  /** electron app.getPath('resourcesPath') equivalent. */
  resourcesPath: () => string
  findOnPath: (command: string) => null | string
  rememberLog: (line: string) => void
}

interface XGrokPtySession {
  pty: nodePty.IPty
  webContentsId: number
  tabId: string
  /** Model and proxy the process was launched with (proxy is process-wide env). */
  model: string
  proxyUrl: string
  /** How the session was started: resume (-c) or forced-new (-s). */
  mode: 'continue' | 'new'
  /** True after a failed -c was retried as -s (guards against loop). */
  switchedToNew?: boolean
  /** True when intentionally torn down by a restart; suppresses its exit event. */
  disposed?: boolean
}

/** Resolve the grok binary: app-bundled copy first, then the machine install. */
export function resolveGrokExecutable(resourcesPath: () => string, findOnPath: (c: string) => null | string): {
  exe: string
  bundled: boolean
} | null {
  const candidates: Array<{ exe: string; bundled: boolean }> = [
    { exe: join(resourcesPath(), 'grok', process.platform === 'win32' ? 'grok.exe' : 'grok'), bundled: true },
    { exe: join(process.cwd(), 'native', 'grok', process.platform === 'win32' ? 'grok.exe' : 'grok'), bundled: true },
    { exe: join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'), bundled: false }
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate.exe)) return candidate
  }
  const onPath = findOnPath(process.platform === 'win32' ? 'grok.exe' : 'grok')

  return onPath ? { exe: onPath, bundled: false } : null
}

export function registerXGrokPtyIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: XGrokPtyDeps) {
  const sessions = new Map<string, XGrokPtySession>()

  function channel(tabId: string, suffix: string) {
    return `xgrok:pty:${tabId}:${suffix}`
  }

  function send(webContents: WebContents, tabId: string, suffix: string, payload: unknown) {
    if (!webContents.isDestroyed()) webContents.send(channel(tabId, suffix), payload)
  }

  function dispose(id: string): boolean {
    const session = sessions.get(id)

    if (!session) return false
    // Mark BEFORE kill: the process's onExit is async and must not emit an
    // exit event (the renderer would clear the NEW session this id handed off to).
    session.disposed = true
    sessions.delete(id)
    try {
      session.pty.kill()
    } catch {
      // Already reaped.
    }

    return true
  }

  function envForGrok(proxyUrl: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // A PTY is a real xterm-256color terminal; never let host NO_COLOR / dumb
    // TERM flip grok's full-screen TUI into a degraded or light-mode render.
    delete env.NO_COLOR
    delete env.FORCE_COLOR
    delete env.COLORFGBG
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'minAgent'
    env.TERM_PROGRAM_VERSION = '1.0'

    // Per-model proxy: Grok's HTTP stack honours these env vars. The proxy is
    // process-wide, so a change requires a fresh PTY (the renderer restarts it
    // when switchModel reports mode='restart').
    const proxy = (proxyUrl || '').trim()
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      if (proxy) env[name] = proxy
      else delete env[name]
    }

    return env
  }

  ipcMain.handle('xgrok:pty:available', () => Boolean(resolveGrokExecutable(deps.resourcesPath, deps.findOnPath)))

  ipcMain.handle('xgrok:pty:exe', () => resolveGrokExecutable(deps.resourcesPath, deps.findOnPath))

  /**
   * Launch grok in a session-intent mode so it skips the welcome/home screen:
   * - 'continue' (-c): resume the most recent session for `cwd`.
   * - 'new' (-s <uuid>): force-create a fresh session with a known id.
   * `-c` with no history exits immediately with an error; the caller falls
   * back to 'new' in that case.
   */
  function launchGrok(
    resolved: { exe: string; bundled: boolean },
    webContents: WebContents,
    id: string,
    cfg: XGrokPtyStartConfig,
    mode: 'continue' | 'new'
  ): { spawned: boolean; error?: string } {
    const cols = Math.max(2, Number.parseInt(String(cfg?.cols || 100), 10) || 100)
    const rows = Math.max(2, Number.parseInt(String(cfg?.rows || 30), 10) || 30)
    const cwd = (cfg.cwd && existsSync(cfg.cwd) ? cfg.cwd : homedir())
    const model = (cfg.model || '').trim()
    const effectiveModel = model || 'deepseek-flash'
    const proxyUrl = (cfg.proxyUrl || '').trim()
    const args: string[] = []

    // Session intent first — without one grok stops on the welcome screen.
    if (mode === 'continue') args.push('-c')
    else args.push('-s', randomUUID())

    args.push('--model', effectiveModel, '--no-auto-update')
    // Scrollback-native rendering. The fullscreen TUI paints the transcript in
    // an alternate screen (no scrollback) and only shows the last N thinking
    // lines while streaming (`truncated_lines` in pager.toml), then folds the
    // block into a one-line "Thought for Xs" row when the turn ends. Minimal
    // mode prints every streamed line — thinking, tool calls and edit diffs —
    // into the normal buffer, so the pane keeps the whole transcript and the
    // user can scroll back through it. pager.toml can raise `truncated_lines`
    // for standalone fullscreen runs, but it cannot preserve finished thinking
    // in the alternate screen, so the embedded pane stays in minimal mode.
    args.push('--minimal')
    const effort = (cfg.effort || '').trim()
    if (effort) args.push('--reasoning-effort', effort)

    deps.rememberLog(`[xgrok:pty] spawn(${mode}) ${resolved.exe} ${args.join(' ')} (cwd=${cwd}, proxy=${proxyUrl ? 'on' : 'off'})`)

    let pty: nodePty.IPty
    try {
      pty = nodePty.spawn(resolved.exe, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: envForGrok(proxyUrl)
      })
    } catch (err) {
      return { spawned: false, error: err instanceof Error ? err.message : String(err) }
    }

    sessions.set(id, {
      pty,
      webContentsId: webContents.id,
      tabId: cfg.tabId,
      model: effectiveModel,
      proxyUrl,
      mode
    })

    let exited = false
    let noSessionError = false
    const startedAt = Date.now()
    pty.onData(data => {
      const current = sessions.get(id)
      // Drop stray output from a PTY that has been superseded by a restart.
      if (!current || current.disposed) return
      // Only this exact message means `-c` had no resumable session for cwd.
      // Other failures (quota, auth, model) must NOT be retried as a new session.
      if (mode === 'continue' && /No session found for current directory/i.test(data)) {
        noSessionError = true
      }
      send(webContents, cfg.tabId, 'data', data)
    })
    pty.onExit(({ exitCode, signal }) => {
      if (exited) return
      const session = sessions.get(id)

      // An intentionally disposed PTY (restart / tab close) must NOT emit an
      // exit event: its id was handed to the successor and a late exit would
      // make the renderer drop the live session — the "typing does nothing" bug.
      if (!session || session.disposed) {
        exited = true
        try { pty.kill() } catch { /* already reaped */ }
        return
      }

      // `-c` found no session → transparently retry as a new session so the
      // user lands straight in a usable TUI, never on the welcome screen.
      // Guard with both the exact error text and a short startup window.
      const fastFail = Date.now() - startedAt < 8000
      if (session.mode === 'continue' && !session.switchedToNew && noSessionError && fastFail) {
        session.switchedToNew = true
        try { pty.kill() } catch { /* already reaped */ }
        deps.rememberLog(`[xgrok:pty] --continue found no session; retrying as new`)
        const retry = launchGrok(resolved, webContents, id, { ...cfg, model: effectiveModel }, 'new')
        if (!retry.spawned) {
          send(webContents, cfg.tabId, 'exit', { sessionId: id, code: exitCode, signal: signal == null ? null : String(signal) })
          sessions.delete(id)
        }
        return
      }

      exited = true
      send(webContents, cfg.tabId, 'exit', { sessionId: id, code: exitCode, signal: signal == null ? null : String(signal) })
      sessions.delete(id)
      try { pty.kill() } catch { /* already reaped */ }
    })

    return { spawned: true }
  }

  ipcMain.handle('xgrok:pty:start', (event: IpcMainInvokeEvent, cfg: XGrokPtyStartConfig): XGrokPtyStartResult => {
    const resolved = resolveGrokExecutable(deps.resourcesPath, deps.findOnPath)

    if (!resolved) {
      return { ok: false, error: '未找到 grok 可执行文件：请确认已安装 Grok Build（~/.grok/bin/grok.exe）或应用内置副本。' }
    }

    const id = `${cfg.tabId}:${Date.now().toString(36)}`
    // A fresh xGrok tab (from 编程 → + xGrok) starts a brand-new empty session;
    // every other entry point resumes the last session for the cwd.
    const mode: 'continue' | 'new' = cfg.newSession ? 'new' : 'continue'
    const started = launchGrok(resolved, event.sender, id, cfg, mode)
    if (!started.spawned) return { ok: false, error: started.error }

    event.sender.once('destroyed', () => dispose(id))

    return { ok: true, id, exe: resolved.exe, bundled: resolved.bundled }
  })

  ipcMain.handle('xgrok:pty:write', (_event, id: string, data: string) => {
    const session = sessions.get(String(id || ''))

    if (!session) return false
    try {
      session.pty.write(String(data || ''))

      return true
    } catch {
      return false
    }
  })

  // Switch the backing model of a live Grok TUI. Grok handles `/model` in
  // process (no restart, session kept) — but the proxy is a process-wide env
  // var, so if the target model needs a different proxy the renderer must
  // restart the PTY. Report which path to take; never write a credential here.
  ipcMain.handle(
    'xgrok:pty:switchModel',
    (_event, payload: { id: string; model: string; proxyUrl?: string }): XGrokPtySwitchResult => {
      const session = sessions.get(String(payload?.id || ''))
      if (!session) return { ok: false, mode: 'restart', error: '会话已结束' }
      const model = (payload.model || '').trim()
      if (!model) return { ok: false, error: '模型 id 为空' }
      const proxyUrl = (payload.proxyUrl || '').trim()

      if (proxyUrl !== session.proxyUrl) {
        return { ok: true, mode: 'restart' }
      }

      try {
        // Verified end-to-end: injecting `/model <id>\r` switches the active
        // model inside the running TUI (Action::SetDefaultModel), keeping the
        // session. A trailing Enter submits it.
        session.pty.write(`/model ${model}\r`)
        session.model = model
        deps.rememberLog(`[xgrok:pty] switch model -> ${model} (in-process)`)

        return { ok: true, mode: 'switched' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('xgrok:pty:resize', (_event, id: string, size: { cols: number; rows: number }) => {
    const session = sessions.get(String(id || ''))

    if (!session) return false
    try {
      const cols = Math.max(2, Number.parseInt(String(size?.cols || 100), 10) || 100)
      const rows = Math.max(2, Number.parseInt(String(size?.rows || 30), 10) || 30)
      session.pty.resize(cols, rows)

      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('xgrok:pty:dispose', (_event, id: string) => dispose(String(id || '')))

  return {
    dispose,
    disposeAll: () => {
      for (const id of [...sessions.keys()]) dispose(id)
    }
  }
}
