import { describe, expect, it } from 'vitest'
import { proxyRulesFromUrl } from './preview-proxy-ipc'

describe('preview proxy rules', () => {
  it('maps an HTTP proxy URL to Electron rules', () => {
    expect(proxyRulesFromUrl('http://user:pass@127.0.0.1:7890')).toBe(
      'http=user:pass@127.0.0.1:7890;https=user:pass@127.0.0.1:7890'
    )
  })

  it('maps SOCKS proxies and rejects other protocols', () => {
    expect(proxyRulesFromUrl('socks5://127.0.0.1:1080')).toBe('socks5=127.0.0.1:1080')
    expect(() => proxyRulesFromUrl('file:///tmp/proxy')).toThrow('Unsupported proxy protocol')
  })
})
