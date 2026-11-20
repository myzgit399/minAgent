// xGrok IPC: embeds the real grok-build Rust engine (xai-grok-ffi cdylib) in
// the Electron main process via koffi. No grok.exe / PTY is involved.
//
// The engine runs each turn on its own Rust thread and appends output lines to
// an in-process queue that we drain with `xgrok_poll` on a short interval. That
// keeps every FFI touch on the JS thread (no cross-thread JS callbacks) while
// still streaming tokens to the renderer as `xgrok:line` events, which the
// xGrok tab renders as a grok-style terminal.
//
// Auth/model selection is delegated to the engine: it resolves credentials from
// `~/.grok/config.toml`, `XAI_API_KEY` and per-model `env_key`s exactly like the
// `grok` CLI does, so the tab inherits whatever the user already configured.
//
// NOTE: the bundled electron-main.mjs already provides a module-scoped `require`
// (createRequire(import.meta.url)) at the top. Do NOT import createRequire /
// fileURLToPath here — a duplicate `createRequire` binding breaks the ESM
// bundle. Use the shared `require` and process.cwd()/resourcesPath only.

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { resolveMainHermesHome } from './main-hermes-home'

export interface XGrokRunConfig {
  /** Renderer tab that owns this turn — echoed on every streamed event. */
  tabId: string
  prompt: string
  apiKey?: string
  /** grok model id; empty = the engine's default for the account. */
  model: string
  /** Reasoning effort token (low/medium/high/…); empty = model default. */
  effort?: string
  proxyUrl: string
  /**
   * Whether this tab routes through the proxy. Unset/`true` keeps the host's
   * resolution (explicit URL → env → `model_proxy.url`); `false` forces a
   * direct connection, so the composer's 代理 switch can actually turn it off.
   */
  useProxy?: boolean
  cwd: string
  yolo?: boolean
  /** Continue this grok session id. */
  resume?: string
  /** Continue the most recent grok session when `resume` is empty. */
  continueLast?: boolean
}

export interface XGrokResult {
  ok: boolean
  error?: string
}

export interface XGrokLineEvent {
  tabId: string
  line: string
}

export interface XGrokDoneEvent {
  tabId: string
  ok: boolean
  error?: string
  /** grok session id, so the tab resumes the same thread next turn. */
  sessionId?: string
}

export interface XGrokModelInfo {
  /** Model id to pass to the engine (`-m`). */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** Provider label from `~/.grok/config.toml`. */
  provider: string
  /** Underlying model when the id is a mapping alias. */
  mappedTo?: string
  /** Reasoning efforts this model advertises. */
  efforts?: string[]
  /** False when no credential resolves for this model, so a run would 401. */
  ready?: boolean
  /** Why a model isn't ready, shown in the picker. */
  blockedBy?: string
}

export interface XGrokModelsPayload {
  /** False when the engine/backing library could not be loaded. */
  available: boolean
  /** Model the engine uses when none is passed. */
  defaultModel: string
  models: XGrokModelInfo[]
  /** Where the list came from, for the tab's status line. */
  source?: string
  error?: string
}

/** Poll cadence while a turn runs: fine enough to feel live, cheap enough to ignore. */
const POLL_MS = 50
/** Drain buffer — one poll can carry a burst of tool output. */
const DRAIN_BYTES = 256 * 1024

/** Built-ins from the grok build model catalog, used when config lists nothing. */
const BUILTIN_MODELS: XGrokModelInfo[] = [
  { id: 'grok-4.6', label: 'Grok 4.6', provider: 'xAI', efforts: ['xhigh', 'high', 'medium', 'low'] },
  { id: 'grok-4.5', label: 'Grok 4.5', provider: 'xAI', efforts: ['high', 'medium', 'low'] },
  { id: 'grok-4', label: 'Grok 4', provider: 'xAI', efforts: ['high', 'medium', 'low'] }
]

function grokHome(): string {
  const fromEnv = process.env.GROK_HOME
  return fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), '.grok')
}

function resourcesPath(): string {
  return (process as any).resourcesPath || ''
}

const DEFAULT_DLL_CANDIDATES = [
  // Packaged app: resources/xgrok/xai_grok_ffi.dll
  join(resourcesPath(), 'xgrok', 'xai_grok_ffi.dll'),
  // Dev workspace candidates (relative to the app working directory)
  resolve(process.cwd(), 'native', 'xgrok', 'xai_grok_ffi.dll'),
  resolve(process.cwd(), '..', '..', 'xgrok', 'target', 'release', 'xai_grok_ffi.dll')
]

/**
 * One model the APP can run, from `providers:` in config.yaml.
 */
interface HermesModelSpec {
  id: string
  provider: string
  baseUrl: string
  apiKey: string
}

/**
 * Every model minAgent itself offers: each provider's `models:` list, or its
 * `default_model` when it lists none. Credentials resolve the same way the
 * gateway resolves them — an inline `api_key` first, then the `key_env` var.
 */
export function readHermesModelSpecs(): HermesModelSpec[] {
  try {
    const configPath = join(resolveMainHermesHome(homedir()), 'config.yaml')
    if (!existsSync(configPath)) return []
    const doc = parseYaml(readFileSync(configPath, 'utf8')) as unknown
    const providers = (doc as { providers?: Record<string, unknown> } | null)?.providers
    if (!providers || typeof providers !== 'object') return []

    const specs: HermesModelSpec[] = []
    for (const [provider, raw] of Object.entries(providers)) {
      const cfg = raw as Record<string, unknown> | null
      const baseUrl = String(cfg?.api ?? '').trim()
      if (!baseUrl) continue
      const keyEnv = String(cfg?.key_env ?? '').trim()
      const apiKey =
        String(cfg?.api_key ?? '').trim() || (keyEnv ? String(process.env[keyEnv] ?? '').trim() : '')
      const listed = Array.isArray(cfg?.models)
        ? (cfg?.models as unknown[]).filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
        : []
      const fallback = String(cfg?.default_model ?? '').trim()
      const ids = listed.length ? listed : fallback ? [fallback] : []
      for (const id of ids) specs.push({ id, provider, baseUrl, apiKey })
    }
    return specs
  } catch {
    return []
  }
}

/**
 * Mirror the app's models into `~/.grok/config.toml`.
 *
 * The engine resolves `base_url` from that file by model id — there is no
 * per-run base_url argument — so a model the picker offers has to have a
 * `[model.<id>]` section or the turn 404s. Idempotent: a section that is
 * already there is left untouched, so this writes once and then never again.
 */
export function syncGrokConfigSections(specs: HermesModelSpec[]): void {
  if (!specs.length) return

  const path = join(grokHome(), 'config.toml')
  let text = ''
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return
  }

  const present = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^\[model\.(?:"([^"]+)"|([^\]]+))\]$/.exec(rawLine.trim())
    if (header) present.add((header[1] || header[2] || '').trim())
  }

  const blocks: string[] = []
  for (const spec of specs) {
    if (!spec.id || present.has(spec.id)) continue
    present.add(spec.id)
    const lines = [
      `[model."${spec.id}"]`,
      `model = "${spec.id}"`,
      `base_url = "${spec.baseUrl}"`,
      'api_backend = "chat_completions"',
      `provider_name = "${spec.provider}"`,
      `name = "${spec.id}"`
    ]
    if (spec.apiKey) lines.push(`api_key = "${spec.apiKey}"`)
    blocks.push(lines.join('\n'))
  }

  if (!blocks.length) return

  try {
    const separator = text && !text.endsWith('\n') ? '\n' : ''
    writeFileSync(path, `${text}${separator}\n${blocks.join('\n\n')}\n`, 'utf8')
  } catch {
    /* read-only home: the picker still lists them; a run reports the 404 */
  }
}

/**
 * Read `~/.grok/config.toml` well enough to list the models the CLI can use.
 * The file is a flat TOML table of `[model.<id>]` sections, so a section scanner
 * is both sufficient and dependency-free (the app ships no TOML parser).
 *
 * The app's own `providers:` catalogue is mirrored in first (see
 * `syncGrokConfigSections`), so the picker offers exactly the models minAgent
 * can run — one app, one model list.
 */
export function readGrokModels(): XGrokModelsPayload {
  // Mirror minAgent's `providers:` catalogue in first, so the list below IS
  // the app's model list, not whatever `grok` was configured with.
  syncGrokConfigSections(readHermesModelSpecs())

  const path = join(grokHome(), 'config.toml')
  const models: XGrokModelInfo[] = []
  const seen = new Set<string>()
  let defaultModel = ''
  const mappings = new Map<string, string>()

  const push = (info: XGrokModelInfo) => {
    if (!info.id || seen.has(info.id)) return
    seen.add(info.id)
    models.push(info)
  }

  try {
    if (!existsSync(path)) throw new Error(`未找到 ${path}`)
    const text = readFileSync(path, 'utf8')
    let section = ''
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header) {
        section = header[1].trim()
        continue
      }
      const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/.exec(line)
      if (!kv) continue
      const key = kv[1].replace(/^["']|["']$/g, '')
      const value = kv[2].trim().replace(/^["']|["']$/g, '')

      if (section === 'models' && key === 'default') {
        defaultModel = value
        continue
      }
      if (section === 'model-mappings') {
        mappings.set(key, value)
        continue
      }
      const modelSection = /^model\.(.+)$/.exec(section)
      if (!modelSection) continue
      const id = modelSection[1].replace(/^["']|["']$/g, '')
      const existing = models.find((m) => m.id === id)
      const target = existing ?? { id, label: id, provider: 'grok', efforts: undefined }
      if (!existing) push(target)
      if (key === 'name' && value) target.label = value
      else if (key === 'provider_name' && value) target.provider = value
      else if (key === 'model' && value && value !== id) target.mappedTo = value
    }
  } catch (err) {
    return {
      available: true,
      defaultModel: defaultModel || 'grok-4.5',
      models: BUILTIN_MODELS.map((m) => ({ ...m })),
      source: 'builtin',
      error: err instanceof Error ? err.message : String(err)
    }
  }

  // Apply model-mappings so the picker shows which real model an alias resolves to.
  for (const m of models) {
    const mapped = mappings.get(m.id)
    if (mapped && !m.mappedTo) m.mappedTo = mapped
  }

  // Keep the config's own order first, then any built-in the config doesn't alias.
  for (const builtin of BUILTIN_MODELS) {
    if (!seen.has(builtin.id)) push({ ...builtin })
  }

  // A model is usable when something can authenticate it: an xAI login, an env
  // var its section names, or an inline api_key. The picker greys out the rest
  // rather than letting a run discover the missing credential as a 401.
  for (const m of models) {
    m.ready = Boolean(resolveGrokApiKey(m.id)) || hasGrokLogin()
    if (!m.ready) m.blockedBy = '未配置凭据'
  }

  return {
    available: true,
    defaultModel: defaultModel || models[0]?.id || 'grok-4.5',
    models,
    source: path
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/** Narrow `config.toml` reader: section → key → value (quotes stripped). */
function readGrokConfig(): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  const path = join(grokHome(), 'config.toml')
  const read = (name: string): Map<string, string> => {
    let section = sections.get(name)
    if (!section) {
      section = new Map()
      sections.set(name, section)
    }
    return section
  }
  if (!existsSync(path)) return sections
  let current = ''
  try {
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header) {
        current = header[1].trim()
        read(current)
        continue
      }
      const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line)
      if (!kv) continue
      read(current).set(stripQuotes(kv[1]), stripQuotes(kv[2].trim()))
    }
  } catch {
    // An unreadable config only means "no credentials found here".
  }
  return sections
}

/**
 * Credentials for `model`, mirroring the CLI's own precedence: the environment
 * wins, then the model section's `api_key`, then whatever its `env_key` names.
 * Returns '' when nothing is configured — the engine then reports its own auth
 * error instead of this layer inventing one. The value is never logged.
 */
export function resolveGrokApiKey(model: string): string {
  const fromEnv = (process.env.XAI_API_KEY || process.env.GROK_CODE_XAI_API_KEY || '').trim()
  if (fromEnv) return fromEnv

  const sections = readGrokConfig()
  const mapped = sections.get('model-mappings')?.get(model) || ''
  const wanted = new Set([model, mapped].filter(Boolean))

  // Sections are keyed `model.<id>`; the id may be quoted and need not equal the
  // wire model (`[model.chatgpt]` with `model = "gpt-4o"`), so match both.
  const candidates: Array<Map<string, string>> = []
  for (const [name, values] of sections) {
    const section = /^model\.(.+)$/.exec(name)
    if (!section) continue
    const id = stripQuotes(section[1])
    if (wanted.has(id) || wanted.has(values.get('model') || '')) candidates.push(values)
  }
  const root = sections.get('')
  if (root?.get('api_key')) candidates.push(root)

  for (const values of candidates) {
    const direct = (values.get('api_key') || '').trim()
    if (direct) return direct
    const envName = (values.get('env_key') || '').trim()
    if (envName) {
      const value = (process.env[envName] || '').trim()
      if (value) return value
    }
  }
  return ''
}

/**
 * True when the CLI has an interactive login on disk. xAI models work either
 * from that session or from an API key; without both the engine can only 401.
 */
export function hasGrokLogin(): boolean {
  return ['auth.json', 'credentials.json'].some((name) => existsSync(join(grokHome(), name)))
}

/**
 * Egress for the engine's HTTPS calls. The tab passes one when the user set it;
 * otherwise fall back to the environment and then to the desktop's own
 * `model_proxy.url`, the route the rest of the app already uses on hosts that
 * cannot reach the API directly.
 */
export function resolveGrokProxy(explicit: string): string {
  const direct = (explicit || '').trim()
  if (direct) return direct
  for (const name of ['GROK_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = (process.env[name] || '').trim()
    if (value) return value
  }
  try {
    const configPath = join(resolveMainHermesHome(homedir()), 'config.yaml')
    if (!existsSync(configPath)) return ''
    // CRLF-tolerant: the desktop's config.yaml is written with Windows endings,
    // and `.*` alone stops at the `\r` so the block would never match.
    const block = /^model_proxy:[^\S\r\n]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m.exec(
      readFileSync(configPath, 'utf8')
    )
    const url = block ? /^\s+url:\s*["']?([^"'\s#]+)/m.exec(block[1]) : null
    return url ? url[1].trim() : ''
  } catch {
    return ''
  }
}

export function registerXGrokIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  getWindow: () => BrowserWindow | null,
  dllPath?: string
): { available: () => boolean } {
  let ffi: any = null
  let lib: any = null
  let initialized = false
  let buffer: Buffer | null = null
  let timer: NodeJS.Timeout | null = null
  /** The tab owning the in-flight turn (the engine runs one turn at a time). */
  let activeTab: string | null = null
  /** Per-tab grok session ids, so tabs keep separate threads. */
  const sessionIds = new Map<string, string>()
  /** Tabs waiting for the engine; the engine is strictly single-turn. */
  const waiting: Array<{ tabId: string; start: () => void }> = []
  /**
   * A cancelled turn keeps running inside Rust (an FFI turn cannot be killed), so
   * the host stops listening. Its remaining lines are flushed before the next
   * turn starts, otherwise they would be tagged with — and rendered by — the
   * next tab.
   */
  let cancelled = false

  const candidates = dllPath ? [dllPath, ...DEFAULT_DLL_CANDIDATES] : DEFAULT_DLL_CANDIDATES
  const found = candidates.find((p) => p && existsSync(p))

  function loadKoffi(): any {
    // Dev: resolve from node_modules; packaged: resources/koffi (extraResource).
    try {
      return require('koffi')
    } catch {
      return require(join(resourcesPath(), 'koffi'))
    }
  }

  function ensureLib(): any {
    if (lib) return lib
    if (!found) return null
    try {
      ffi = loadKoffi()
      lib = ffi.load(found)
      // koffi 2.x exposes function binding on the loaded library object.
      lib.xgrok_init = lib.func('void xgrok_init()')
      lib.xgrok_poll = lib.func('int xgrok_poll(uint8_t *buf, int cap)')
      lib.xgrok_busy = lib.func('int xgrok_busy()')
      lib.xgrok_run_ex = lib.func(
        'void *xgrok_run_ex(str api_key, str model, str proxy_url, str prompt, str cwd, int yolo, str effort, str resume, int continue_last)'
      )
      lib.xgrok_free = lib.func('void xgrok_free(void *ptr)')
      lib.xgrok_version = lib.func('void *xgrok_version()')
      buffer = Buffer.alloc(DRAIN_BYTES)
      return lib
    } catch (err) {
      console.error('[xgrok] failed to load native library:', err)
      return null
    }
  }

  /**
   * Read a C string the engine handed back through a `void *` and release it.
   * Declaring these exports as `str` in koffi makes koffi copy the text and drop
   * the pointer, so the CString leaks every call and handing the JS string back
   * to xgrok_free() corrupts the heap (observed as a segfault on exit).
   */
  function takeString(ptr: unknown): string {
    if (!ptr) return ''
    try {
      const text = typeof ffi?.decode === 'function' ? ffi.decode(ptr as any, 'char', -1) : ''
      return typeof text === 'string' ? text : String(text ?? '')
    } catch (err) {
      console.error('[xgrok] failed to decode native string:', err)
      return ''
    } finally {
      lib?.xgrok_free?.(ptr as any)
    }
  }

  function sendTo(channel: string, payload: unknown): void {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function init(): boolean {
    if (initialized) return true
    const l = ensureLib()
    if (!l) return false
    try {
      l.xgrok_init()
      initialized = true
      return true
    } catch (err) {
      console.error('[xgrok] failed to init engine:', err)
      return false
    }
  }

  function drainQueue(): void {
    if (activeTab) return
    const next = waiting.shift()
    if (!next) return
    activeTab = next.tabId
    next.start()
  }

  function finish(event: XGrokDoneEvent): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    activeTab = null
    if (event.sessionId) sessionIds.set(event.tabId, event.sessionId)
    sendTo('xgrok:done', event)
    drainQueue()
  }

  /** Drain the engine queue and forward every complete line to the owning tab. */
  function pump(): void {
    const tabId = activeTab
    const l = lib
    const buf = buffer
    if (!tabId || !l || !buf) return
    for (;;) {
      let n = 0
      try {
        n = l.xgrok_poll(buf, buf.length)
      } catch (err) {
        console.error('[xgrok] poll failed:', err)
        return
      }
      if (!n || n <= 0) return

      const chunk = buf.toString('utf8', 0, n)
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Track the grok session id so the tab can resume the same thread.
        if (trimmed.includes('"sessionId"')) {
          try {
            const parsed = JSON.parse(trimmed)
            const sid = parsed?.sessionId ?? parsed?.session_id
            if (typeof sid === 'string' && sid) sessionIds.set(tabId, sid)
          } catch {
            /* non-JSON line: leave it to the renderer */
          }
        }
        if (trimmed.startsWith('{"type":"xgrok_done"')) {
          try {
            const done = JSON.parse(trimmed)
            finish({
              tabId,
              ok: Boolean(done.ok),
              error: done.error,
              sessionId: done.sessionId ?? sessionIds.get(tabId)
            })
            // The turn is over: stop polling here, or this pump's captured tabId
            // would swallow the next turn's lines.
            return
          } catch {
            /* fall through and render it */
          }
        }
        sendTo('xgrok:line', { tabId, line: trimmed } satisfies XGrokLineEvent)
      }
    }
  }

  /** Wait for the engine thread to go idle (used after a cancel). */
  async function waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (lib && lib.xgrok_busy() !== 0) {
      if (Date.now() > deadline) return false
      await new Promise(r => setTimeout(r, 100))
    }
    return true
  }

  /** Throw away the tail of a cancelled turn so it cannot leak into a tab. */
  function flushStale(): void {
    if (!lib || !buffer) return
    for (let guard = 0; guard < 100_000; guard++) {
      const n = lib.xgrok_poll(buffer, buffer.length)
      if (!n || n <= 0) break
    }
    if (lib.xgrok_busy() === 0) cancelled = false
  }

  function startPump(tabId: string): void {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      pump()
      // Safety net: the engine cleared BUSY but the done line was lost.
      if (activeTab === tabId && lib && lib.xgrok_busy() === 0) {
        pump()
        if (activeTab === tabId) finish({ tabId, ok: true, sessionId: sessionIds.get(tabId) })
      }
    }, POLL_MS)
  }

  ipcMain.handle('xgrok:available', () => Boolean(found))

  ipcMain.handle('xgrok:models', (): XGrokModelsPayload => {
    const payload = readGrokModels()
    return { ...payload, available: Boolean(found) || payload.available }
  })

  ipcMain.handle('xgrok:version', () => {
    const l = ensureLib()
    if (!l) return 'unavailable'
    try {
      return takeString(l.xgrok_version())
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  ipcMain.handle('xgrok:run', async (_e: IpcMainInvokeEvent, cfg: XGrokRunConfig): Promise<XGrokResult> => {
    if (!init()) {
      return { ok: false, error: 'xGrok 引擎不可用：未找到 xai_grok_ffi.dll 或 koffi 加载失败' }
    }
    const l = ensureLib()
    if (!l) return { ok: false, error: 'xGrok 引擎不可用' }

    // A cancelled turn is still unwinding inside Rust: wait for it, then discard
    // its trailing lines so they cannot surface in this tab.
    if (cancelled) {
      await waitIdle(120_000)
      flushStale()
    }

    const resume = cfg.resume || sessionIds.get(cfg.tabId) || ''
    // Credentials and egress resolve here, not in the renderer: the tab never
    // has to know where the key lives or how the host reaches the API.
    const apiKey = (cfg.apiKey || '').trim() || resolveGrokApiKey(cfg.model || '')
    const proxyUrl = cfg.useProxy === false ? '' : resolveGrokProxy(cfg.proxyUrl)

    // One line of ground truth: what actually reached the engine this turn
    // (never the credential). Makes "the pill really switched" checkable.
    console.log('[xgrok] run', JSON.stringify({
      tabId: cfg.tabId,
      model: cfg.model || '',
      effort: cfg.effort || '',
      cwd: cfg.cwd || '',
      yolo: !!cfg.yolo,
      resume: !!resume,
      continueLast: !!cfg.continueLast,
      key: apiKey ? 'resolved' : 'none',
      proxy: proxyUrl ? 'set' : 'none'
    }))


    // A fresh install has no xAI credential at all, so say so here instead of
    // paying a round-trip for a 401 the engine reports as an opaque auth error.
    // An empty model means the engine's own default, which is an xAI model.
    const model = (cfg.model || '').trim()
    if (!apiKey && !hasGrokLogin() && (!model || /^grok\b/i.test(model))) {
      return {
        ok: false,
        error: '未登录 xAI：请先在终端运行 `grok /login`，或设置 XAI_API_KEY 后重启应用'
      }
    }

    // Queue behind the in-flight turn instead of rejecting: several tabs can be
    // open, the engine runs them one after another.
    const started = new Promise<XGrokResult>((resolveTurn) => {
      const start = () => {
        try {
          const raw = takeString(
            l.xgrok_run_ex(
              apiKey,
              cfg.model || '',
              proxyUrl,
              cfg.prompt || '',
              cfg.cwd || '',
              cfg.yolo ? 1 : 0,
              cfg.effort || '',
              resume,
              cfg.continueLast ? 1 : 0
            )
          )
          let parsed: XGrokResult
          try {
            parsed = raw ? JSON.parse(raw) : { ok: false, error: '引擎未返回结果' }
          } catch {
            parsed = { ok: false, error: `引擎返回了无法解析的结果: ${String(raw).slice(0, 200)}` }
          }

          if (!parsed.ok) {
            activeTab = null
            sendTo('xgrok:done', { tabId: cfg.tabId, ok: false, error: parsed.error } satisfies XGrokDoneEvent)
            drainQueue()
            resolveTurn(parsed)
            return
          }

          startPump(cfg.tabId)
          resolveTurn({ ok: true })
        } catch (err) {
          activeTab = null
          drainQueue()
          resolveTurn({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      }

      if (activeTab) waiting.push({ tabId: cfg.tabId, start })
      else {
        activeTab = cfg.tabId
        start()
      }
    })

    return started
  })

  ipcMain.handle('xgrok:cancel', (_e: IpcMainInvokeEvent, tabId: string) => {
    const idx = waiting.findIndex((w) => w.tabId === tabId)
    if (idx >= 0) {
      waiting.splice(idx, 1)
      return true
    }
    if (activeTab === tabId) {
      // The Rust turn cannot be killed; mark it orphaned so its tail is flushed
      // before the next turn and the renderer stops showing it as running.
      cancelled = true
      finish({ tabId, ok: false, error: '已取消' })
    }
    return true
  })

  ipcMain.handle('xgrok:busy', () => Boolean(activeTab))

  return { available: () => Boolean(found) }
}
