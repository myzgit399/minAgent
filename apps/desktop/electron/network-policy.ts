import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { URL } from 'node:url'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
let installed = false

function configuredHosts(): Set<string> {
  const hosts = new Set<string>(LOCAL_HOSTS)
  for (const item of String(process.env.HERMES_NETWORK_ALLOWLIST || '').split(',')) {
    const host = item.trim().toLowerCase()
    if (host) hosts.add(host)
  }

  const homes = [
    process.env.HERMES_HOME,
    path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '', '.config'), 'hermes'),
    path.join(process.env.HOME || '', '.hermes'),
  ].filter(Boolean) as string[]

  for (const home of homes) {
    const configPath = path.join(home, 'config.yaml')
    try {
      const text = fs.readFileSync(configPath, 'utf8')
      for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)(?::\d+)?/g)) {
        hosts.add(match[1].toLowerCase())
      }
    } catch {
      // Missing config is fine; the built-in loopback allowlist still applies.
    }
  }
  return hosts
}

function assertAllowedUrl(value: unknown): void {
  if (typeof value !== 'string' && !(value instanceof URL)) return
  const url = typeof value === 'string' ? new URL(value) : value
  if (!allowed.has((url.hostname || '').toLowerCase())) {
    throw new Error(`Network destination ${url.hostname} blocked by local-only Hermes network policy`)
  }
}

let allowed = configuredHosts()

/** Block all outbound destinations except loopback and configured model provider hosts. */
export function installLocalNetworkPolicy(): void {
  if (installed) return
  installed = true
  allowed = configuredHosts()

  const originalHttpRequest = http.request
  const originalHttpsRequest = https.request
  const originalNetConnect = net.connect

  ;(http.request as typeof http.request) = ((...args: any[]) => {
    assertAllowedUrl(args[0])
    return (originalHttpRequest as any)(...args)
  }) as typeof http.request

  ;(https.request as typeof https.request) = ((...args: any[]) => {
    assertAllowedUrl(args[0])
    return (originalHttpsRequest as any)(...args)
  }) as typeof https.request

  ;(net.connect as typeof net.connect) = ((...args: any[]) => {
    const host = typeof args[0] === 'string' ? args[0] : args[0]?.host
    if (host && !allowed.has(String(host).toLowerCase())) {
      throw new Error(`Network destination ${host} blocked by local-only Hermes network policy`)
    }
    return (originalNetConnect as any)(...args)
  }) as typeof net.connect

  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    assertAllowedUrl(input)
    return originalFetch(input, init)
  }) as typeof fetch
}
