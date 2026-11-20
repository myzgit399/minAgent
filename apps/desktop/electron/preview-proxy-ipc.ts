import { ipcMain, session } from 'electron'
import { isPreviewPartition } from './preview-guest-throttle'

export const PREVIEW_PROXY_CHANNEL = 'hermes:preview:proxy'
export const PREVIEW_COOKIE_CHANNEL = 'hermes:preview:cookie'

export function proxyRulesFromUrl(raw: string): string {
  const url = new URL(raw.trim())
  const protocol = url.protocol.replace(':', '').toLowerCase()
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    throw new Error('Unsupported proxy protocol')
  }
  const auth = url.username ? `${decodeURIComponent(url.username)}${url.password ? ':' + decodeURIComponent(url.password) : ''}@` : ''
  const target = `${auth}${url.hostname}${url.port ? ':' + url.port : ''}`
  return protocol.startsWith('socks')
    ? `socks5=${target}`
    : `http=${target};https=${target}`
}

export async function applyPreviewProxy(request: {
  partition?: string
  enabled?: boolean
  proxyUrl?: string
}): Promise<{ ok: boolean }> {
  const partition = String(request.partition || '')
  if (!isPreviewPartition(partition)) {
    throw new Error('Preview partition rejected')
  }

  const target = session.fromPartition(partition)
  if (!request.enabled) {
    await target.setProxy({ mode: 'direct' })
    return { ok: true }
  }

  const url = String(request.proxyUrl || '').trim()
  if (!url) {
    throw new Error('No proxy URL configured')
  }
  await target.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxyRulesFromUrl(url),
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1'
  })
  return { ok: true }
}

/** Read the single WPS session cookie from this tab's own guest partition. */
export async function readPreviewWpsSid(request: {
  partition?: string
  url?: string
}): Promise<string> {
  const partition = String(request.partition || '')
  if (!isPreviewPartition(partition)) {
    throw new Error('Preview partition rejected')
  }
  const url = new URL(String(request.url || ''))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Cookie URL must be http(s)')
  }
  const host = url.hostname.toLowerCase()
  if (!host.endsWith('.wps.cn') && !host.endsWith('.kdocs.cn') && host !== 'wps.cn' && host !== 'kdocs.cn') {
    throw new Error('WPS cookie URL rejected')
  }
  const cookies = await session.fromPartition(partition).cookies.get({ url: url.toString() })

  return cookies.find(cookie => cookie.name === 'wps_sid')?.value || ''
}

export function registerPreviewProxyIpc(ipc: Pick<Electron.IpcMain, 'handle'> = ipcMain): void {
  ipc.handle(PREVIEW_PROXY_CHANNEL, (_event, request) => applyPreviewProxy(request))
  ipc.handle(PREVIEW_COOKIE_CHANNEL, (_event, request) => readPreviewWpsSid(request))
}
