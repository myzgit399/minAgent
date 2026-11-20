// xGrok model catalog + per-model proxy policy.
//
// The Grok Build TUI resolves its model list from `~/.grok/config.toml`
// (`[model.<id>]` sections, including the ones minAgent mirrors from its own
// `providers:` catalogue). This module surfaces that list to the xGrok tab,
// grouped by provider exactly the way minAgent's composer groups its models.
//
// The proxy policy is NOT stored separately here. It is read/written through
// minAgent's own backend `GET/PUT /api/config` — the exact same source the
// Settings → Model → main-model "Proxy URL" field uses — so the two UIs share
// one source of truth (including profile scope). A per-model toggle writes
// `model_proxy.models[<key>]` as a sparse deep-merged PUT, exactly like
// minAgent's model-options menu does.

import type { IpcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { resolveMainHermesHome } from './main-hermes-home'

export interface XGrokCatalogModel {
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

export interface XGrokCatalogGroup {
  id: string
  label: string
  models: XGrokCatalogModel[]
}

export interface XGrokCatalogPayload {
  available: boolean
  groups: XGrokCatalogGroup[]
  models: XGrokCatalogModel[]
  defaultModel: string
  proxyUrl: string
  source: string
  error?: string
}

export interface XGrokModelDeps {
  rememberLog: (line: string) => void
  /** minAgent backend request (same transport as window.hermesDesktop.api). */
  api: (request: { method: string; path: string; body?: unknown }) => Promise<unknown>
}

function grokHome(): string {
  const fromEnv = process.env.GROK_HOME
  return fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), '.grok')
}

function hermesConfigPath(): string {
  return join(resolveMainHermesHome(homedir()), 'config.yaml')
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim()
}

interface ModelProxyState {
  url: string
  models: Record<string, boolean>
}

/** Extract model_proxy from a backend /api/config payload. */
function extractModelProxy(config: unknown): ModelProxyState {
  const state: ModelProxyState = { url: '', models: {} }
  const section = (config as { model_proxy?: Record<string, unknown> } | null)?.model_proxy
  if (!section || typeof section !== 'object') return state
  if (typeof section.url === 'string') state.url = section.url.trim()
  if (section.models && typeof section.models === 'object') {
    for (const [key, value] of Object.entries(section.models as Record<string, unknown>)) {
      state.models[key] = value === true || (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()))
    }
  }
  return state
}

/** Fallback: read model_proxy from the on-disk config.yaml when the API is unavailable. */
function readModelProxyStateFile(): ModelProxyState {
  const path = hermesConfigPath()
  if (!existsSync(path)) return { url: '', models: {} }
  try {
    return extractModelProxy(parseYaml(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return { url: '', models: {} }
  }
}

/** Read minAgent's per-model proxy policy from the SAME source as its UI. */
export async function readModelProxyState(deps: XGrokModelDeps): Promise<ModelProxyState> {
  try {
    const config = await deps.api({ method: 'GET', path: '/api/config' })
    const state = extractModelProxy(config)
    // The backend /api/config merges DEFAULT_CONFIG; if it lacks model_proxy
    // entirely, fall back to disk (covers a just-saved file before backend sync).
    if (!state.url && Object.keys(state.models).length === 0) {
      const disk = readModelProxyStateFile()
      return disk.url || Object.keys(disk.models).length ? disk : state
    }
    return state
  } catch {
    return readModelProxyStateFile()
  }
}

/** Stable key matching agent/model_proxy.py::model_proxy_key. */
export function modelProxyKey(provider: string, id: string): string {
  const slug = (provider || '').trim()
  const name = (id || '').trim()
  return slug && name ? `${slug}::${name}` : name || slug
}

/** Is this model toggled on for the proxy (via any accepted key)? */
export function isModelProxyEnabled(state: ModelProxyState, provider: string, id: string): boolean {
  const slug = (provider || '').trim()
  const name = (id || '').trim()
  const candidates = [modelProxyKey(slug, name), name, slug].filter(Boolean)
  for (const key of Object.keys(state.models)) {
    const [prefix, model] = key.split('::')
    if (model === name && prefix?.split(':').some(part => part === slug)) candidates.push(key)
  }
  return candidates.some(key => state.models[key] === true)
}

export function proxyUrlForModel(state: ModelProxyState, provider: string, id: string): string {
  return isModelProxyEnabled(state, provider, id) ? state.url.trim() : ''
}

/** Read the grok model catalogue, applying minAgent's proxy policy. */
export async function readCatalog(deps: XGrokModelDeps): Promise<XGrokCatalogPayload> {
  const proxy = await readModelProxyState(deps)
  const path = join(grokHome(), 'config.toml')
  const models: XGrokCatalogModel[] = []
  let defaultModel = ''
  const mappings = new Map<string, string>()

  try {
    if (!existsSync(path)) throw new Error(`未找到 ${path}`)
    const text = readFileSync(path, 'utf8')
    let section = ''
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header) { section = header[1].trim(); continue }
      const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/.exec(line)
      if (!kv) continue
      const key = stripQuotes(kv[1])
      const value = stripQuotes(kv[2])

      if (section === 'models' && key === 'default') { defaultModel = value; continue }
      if (section === 'model-mappings') { mappings.set(key, value); continue }
      const modelSection = /^model\.(.+)$/.exec(section)
      if (!modelSection) continue
      const id = stripQuotes(modelSection[1])
      let model = models.find(m => m.id === id)
      if (!model) {
        model = { id, label: id, group: 'grok', groupLabel: 'Grok', proxyEnabled: false }
        models.push(model)
      }
      if (key === 'name' && value) model.label = value
      else if (key === 'provider_name' && value) { model.group = value; model.groupLabel = value }
      else if (key === 'model' && value && value !== id) model.mappedTo = value
      else if (key === 'base_url' && value) model.baseUrl = value
    }
  } catch (err) {
    return {
      available: true, groups: [], models: [], defaultModel: 'deepseek-flash',
      proxyUrl: proxy.url, source: path, error: err instanceof Error ? err.message : String(err)
    }
  }

  for (const model of models) {
    const mapped = mappings.get(model.id)
    if (mapped && !model.mappedTo) model.mappedTo = mapped
    model.ready = Boolean(model.baseUrl || model.mappedTo || /^grok\b/i.test(model.id))
    model.proxyEnabled = isModelProxyEnabled(proxy, model.group, model.id)
  }

  const groupMap = new Map<string, XGrokCatalogGroup>()
  for (const model of models) {
    let group = groupMap.get(model.group)
    if (!group) { group = { id: model.group, label: model.groupLabel, models: [] }; groupMap.set(model.group, group) }
    group.models.push(model)
  }

  return {
    available: true,
    groups: [...groupMap.values()],
    models,
    defaultModel: defaultModel || models[0]?.id || 'deepseek-flash',
    proxyUrl: proxy.url,
    source: path
  }
}

/** Persist a per-model proxy toggle via minAgent's backend (sparse deep-merge PUT). */
export async function setModelProxy(
  deps: XGrokModelDeps,
  provider: string,
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Sparse write: only the toggled model key, deep-merged server-side.
    // minAgent models proxy state as bool — true = proxy, false = force-direct.
    await deps.api({
      method: 'PUT',
      path: '/api/config',
      body: { config: { model_proxy: { models: { [id]: enabled } } } }
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `写入代理配置失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function registerXGrokModelIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: XGrokModelDeps) {
  ipcMain.handle('xgrok:model:catalog', () => readCatalog(deps))
  ipcMain.handle('xgrok:model:proxy', async (_event, payload: { provider: string; id: string; enabled: boolean }) => {
    const result = await setModelProxy(deps, String(payload?.provider || ''), String(payload?.id || ''), Boolean(payload?.enabled))
    if (result.ok) deps.rememberLog(`[xgrok:model] proxy ${payload?.enabled ? 'on' : 'off'} ${payload?.provider}::${payload?.id}`)
    return result
  })
  ipcMain.handle('xgrok:model:proxyState', () => readModelProxyState(deps))
}
