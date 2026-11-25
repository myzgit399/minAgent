import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { GUEST_EXTERNAL_CHANNEL, type GuestClickEvent, installGuestExternalHandoff } from './preview-guest-preload'

// Preview-pane guest bridge (#112941): a trusted click that leaves the guest
// stranded (a denied popup, or a page handler that swallowed the navigation)
// is handed to the host; an ordinary click that navigates in place is alone.
function rig(initialHref = 'https://www.eastmoney.com/') {
  const sent: { channel: string; args: unknown[] }[] = []
  const listeners: { type: string; listener: (event: GuestClickEvent) => void; capture?: boolean }[] = []
  const deferred: { callback: () => void; delayMs: number }[] = []
  let href = initialHref

  installGuestExternalHandoff({
    addEventListener: (type, listener, capture) => listeners.push({ capture, listener, type }),
    defer: (callback, delayMs) => deferred.push({ callback, delayMs }),
    getLocationHref: () => href,
    sendToHost: (channel, ...args) => sent.push({ args, channel })
  })

  return {
    click: (event: GuestClickEvent) => listeners[0].listener(event),
    deferred,
    flush: () => {
      while (deferred.length) {
        deferred.shift()?.callback()
      }
    },
    listeners,
    navigate: (next: string) => { href = next },
    sent
  }
}

const anchor = (href: string, extra: { rawHref?: string; target?: string } = {}) => ({
  closest: (selector: string) =>
    selector === 'a[href]'
      ? {
          href,
          target: extra.target,
          getAttribute: (name: string) => (name === 'href' ? (extra.rawHref ?? null) : null)
        }
      : null
})

describe('installGuestExternalHandoff', () => {
  test('a trusted click inside a _blank anchor is forwarded once, in the capture phase', () => {
    const { click, flush, listeners, sent } = rig()

    assert.deepEqual(
      listeners.map(entry => [entry.type, entry.capture]),
      [['click', true]]
    )

    click({ button: 0, isTrusted: true, target: anchor('https://www.google.com/search?q=traceback', { target: '_blank' }) })
    flush()

    assert.deepEqual(sent, [{ args: ['https://www.google.com/search?q=traceback'], channel: GUEST_EXTERNAL_CHANNEL }])
  })

  test('synthetic clicks, non-primary buttons and non-anchor targets are dropped', () => {
    const { click, flush, sent } = rig()

    // Page script dispatching its own click event must not reach the browser.
    click({ button: 0, isTrusted: false, target: anchor('https://evil.example/') })
    click({ button: 1, isTrusted: true, target: anchor('https://evil.example/') })
    click({ button: 0, isTrusted: true, target: { closest: () => null } })
    click({ button: 0, isTrusted: true, target: anchor('') })
    click({ button: 0, isTrusted: true, target: null })
    flush()

    assert.deepEqual(sent, [])
  })

  test('an anchor whose navigation was swallowed by a page popup is forwarded', () => {
    const { click, deferred, flush, sent } = rig()
    const url = 'https://fund.eastmoney.com/'

    click({ button: 0, isTrusted: true, target: anchor(url) })
    assert.deepEqual(sent, [])
    assert.equal(deferred.length, 1)
    assert.ok(deferred[0].delayMs >= 100)

    flush()

    assert.deepEqual(sent, [{ args: [url], channel: GUEST_EXTERNAL_CHANNEL }])
  })

  test('an anchor that navigated in place is left alone', () => {
    const { click, flush, navigate, sent } = rig()
    const url = 'https://fund.eastmoney.com/'

    click({ button: 0, isTrusted: true, target: anchor(url) })
    navigate(url)
    flush()

    assert.deepEqual(sent, [])
  })

  test('a fragment-only link and a link to the current page are not turned into tabs', () => {
    const { click, flush, sent } = rig()

    click({
      button: 0,
      isTrusted: true,
      target: anchor('https://www.eastmoney.com/#section', { rawHref: '#section' })
    })
    click({ button: 0, isTrusted: true, target: anchor('https://www.eastmoney.com/') })
    flush()

    assert.deepEqual(sent, [])
  })

  test('modifier clicks on ordinary anchors are forwarded as popup requests', () => {
    const { click, flush, sent } = rig()
    const url = 'https://data.eastmoney.com/'

    click({ button: 0, ctrlKey: true, isTrusted: true, target: anchor(url) })
    click({ button: 0, isTrusted: true, metaKey: true, target: anchor(url) })
    click({ button: 0, isTrusted: true, shiftKey: true, target: anchor(url) })
    flush()

    assert.deepEqual(sent, [
      { args: [url], channel: GUEST_EXTERNAL_CHANNEL },
      { args: [url], channel: GUEST_EXTERNAL_CHANNEL },
      { args: [url], channel: GUEST_EXTERNAL_CHANNEL }
    ])
  })
})
