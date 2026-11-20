import { atom } from 'nanostores'

/**
 * xGrok tabs — the grok-build engine embedded as a first-class minAgent tab.
 *
 * Each tab is an independent grok session: its own transcript buffer, model,
 * reasoning effort, working directory and engine session id. The tiles are
 * persisted (order + config), the transcripts are not — the engine thread lives
 * in the main process and is resumed by session id on the next turn.
 */

export interface XGrokTile {
  id: string
  title: string
  /** grok model id (`-m`); empty = the engine/config default. */
  model: string
  /** Reasoning effort token; empty = model default. */
  effort: string
  /** Working directory the engine runs in. */
  cwd: string
  /** True when minted from 编程 → + xGrok: start a brand-new session (-s). */
  freshSession?: boolean
  /**
   * Route the engine's HTTPS calls through the app's configured
   * `model_proxy.url`. Unset = on (the host's proxy is the only way out on
   * blocked networks); `false` forces a direct connection for this tab.
   */
  proxy?: boolean
}

export interface XGrokLine {
  id: number
  text: string
}

const TILES_KEY = 'hermes.desktop.xgrokTiles.v1'
const MAX_LINES = 6000

let tileSeq = 0
let lineSeq = 0

function readTiles(): XGrokTile[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(TILES_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t: any) => t && typeof t.id === 'string')
      .map((t: any) => ({
        id: t.id,
        title: typeof t.title === 'string' && t.title ? t.title : 'grok',
        model: typeof t.model === 'string' ? t.model : '',
        effort: typeof t.effort === 'string' ? t.effort : '',
        cwd: typeof t.cwd === 'string' ? t.cwd : '',
        ...(t.freshSession === true ? { freshSession: true } : {}),
        ...(typeof t.proxy === 'boolean' ? { proxy: t.proxy } : {})
      }))
  } catch {
    return []
  }
}

export const $xgrokTiles = atom<XGrokTile[]>(readTiles())
/** Transcript per tab id — kept out of the tiles so config writes stay cheap. */
export const $xgrokBuffers = atom<Record<string, XGrokLine[]>>({})
export const $xgrokRunning = atom<Record<string, boolean>>({})
export const $xgrokModels = atom<XGrokModelEntry[]>([])
export const $xgrokModelsLoaded = atom<boolean>(false)
/** Engine session id per tab, so a tab continues its own thread. */
export const $xgrokSessions = atom<Record<string, string>>({})

export interface XGrokModelEntry {
  id: string
  label: string
  provider: string
  mappedTo?: string
  /** False when no credential resolves for this model — a run would 401. */
  ready?: boolean
  /** Why the model can't run, shown in the picker. */
  blockedBy?: string
  efforts?: string[]
}

function persist(tiles: XGrokTile[]): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(TILES_KEY, JSON.stringify(tiles))
  } catch {
    /* storage full or unavailable: tiles still work for this run */
  }
}

function writeTiles(next: XGrokTile[]): void {
  $xgrokTiles.set(next)
  persist(next)
}

export function openXGrokTile(init?: Partial<Omit<XGrokTile, 'id'>>): string {
  const tiles = $xgrokTiles.get()
  const used = new Set(tiles.map((t) => t.title))
  let n = 1
  while (used.has(`grok ${n}`)) n += 1
  const tile: XGrokTile = {
    id: `xgrok-${Date.now().toString(36)}-${(tileSeq += 1)}`,
    title: init?.title || `grok ${n}`,
    model: init?.model ?? '',
    effort: init?.effort ?? '',
    cwd: init?.cwd ?? '',
    ...(init?.freshSession ? { freshSession: true } : {})
  }
  writeTiles([...tiles, tile])
  $xgrokBuffers.set({ ...$xgrokBuffers.get(), [tile.id]: [] })
  return tile.id
}

export function closeXGrokTile(id: string): void {
  writeTiles($xgrokTiles.get().filter((t) => t.id !== id))
  const buffers = { ...$xgrokBuffers.get() }
  delete buffers[id]
  $xgrokBuffers.set(buffers)
  const running = { ...$xgrokRunning.get() }
  delete running[id]
  $xgrokRunning.set(running)
  const sessions = { ...$xgrokSessions.get() }
  delete sessions[id]
  $xgrokSessions.set(sessions)
}

export function patchXGrokTile(id: string, patch: Partial<Omit<XGrokTile, 'id'>>): void {
  let changed = false
  const next = $xgrokTiles.get().map((t) => {
    if (t.id !== id) return t
    const merged = { ...t, ...patch }
    if (merged.title === t.title && merged.model === t.model && merged.effort === t.effort && merged.cwd === t.cwd) {
      return t
    }
    changed = true
    return merged
  })
  if (changed) writeTiles(next)
}

export function getXGrokTile(id: string): XGrokTile | undefined {
  return $xgrokTiles.get().find((t) => t.id === id)
}

export function appendXGrokLine(tabId: string, text: string): void {
  const buffers = $xgrokBuffers.get()
  const prev = buffers[tabId] ?? []
  const next = [...prev, { id: (lineSeq += 1), text }]
  $xgrokBuffers.set({ ...buffers, [tabId]: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next })
}

export function clearXGrokTile(tabId: string): void {
  $xgrokBuffers.set({ ...$xgrokBuffers.get(), [tabId]: [] })
}

export function setXGrokRunning(tabId: string, running: boolean): void {
  $xgrokRunning.set({ ...$xgrokRunning.get(), [tabId]: running })
}

export function setXGrokSession(tabId: string, sessionId: string): void {
  $xgrokSessions.set({ ...$xgrokSessions.get(), [tabId]: sessionId })
}

export function setXGrokModel(tabId: string, model: string): void {
  patchXGrokTile(tabId, { model })
}

export function setXGrokEffort(tabId: string, effort: string): void {
  patchXGrokTile(tabId, { effort })
}

/** Model catalog from `~/.grok/config.toml`, fetched once per app run. */
export async function loadXGrokModels(force = false): Promise<XGrokModelEntry[]> {
  if (!force && $xgrokModelsLoaded.get()) return $xgrokModels.get()
  try {
    const payload = await window.hermesDesktop.xgrokModels()
    const models = (payload?.models ?? []).map((m) => ({
      id: m.id,
      label: m.label || m.id,
      provider: m.provider || 'grok',
      mappedTo: m.mappedTo,
      efforts: m.efforts,
      ready: m.ready !== false,
      blockedBy: m.blockedBy
    }))
    $xgrokModels.set(models)
    if (payload?.defaultModel) $xgrokDefaultModel.set(payload.defaultModel)
    $xgrokModelsLoaded.set(true)
    return models
  } catch {
    $xgrokModelsLoaded.set(true)
    return $xgrokModels.get()
  }
}

/** Engine's default model id, from the config catalog. */
export const $xgrokDefaultModel = atom<string>('')

export function setXGrokDefaultModel(model: string): void {
  $xgrokDefaultModel.set(model)
}
