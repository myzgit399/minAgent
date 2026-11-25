// Logic half of the preview pane's guest preload. The wiring half lives in
// `preview-guest-preload-entry.ts` (the bundled preload itself); this split
// keeps the handoff rules unit-testable in a plain Node environment.
//
// Mirrored by `PREVIEW_EXTERNAL_CHANNEL` in src/lib/preview-external.ts — the
// renderer tsconfig cannot import from electron/.
export const GUEST_EXTERNAL_CHANNEL = 'preview-open-external'

/** Give Chromium time to commit an ordinary in-place navigation before we
 *  decide the click was swallowed by a denied popup. */
const NAVIGATION_SETTLE_MS = 500

interface GuestAnchor {
  getAttribute?: (name: string) => string | null
  href: string
  target?: string | null
}

interface GuestEventTarget {
  closest(selector: string): GuestAnchor | null
}

export interface GuestClickEvent {
  button?: number
  ctrlKey?: boolean
  isTrusted?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  target?: unknown
}

export interface GuestHandoffHost {
  addEventListener(type: 'click', listener: (event: GuestClickEvent) => void, capture?: boolean): void
  defer(callback: () => void, delayMs: number): void
  getLocationHref(): string
  sendToHost(channel: string, ...args: unknown[]): void
}

/**
 * Wire the DOM-capture listener that forwards a clicked anchor's absolute URL
 * to the host. `host` is injected so the entry can pass the guest's
 * `document` and `ipcRenderer`, and tests can drive the same rules without
 * Electron or a DOM.
 *
 * Only a trusted primary-button click qualifies. `isTrusted` is what keeps
 * this bridge out of the gesture-less forced-navigation class
 * (GHSA-9f4c-93c8-jc8g): page script can `dispatchEvent` a synthetic click
 * on an anchor, but it cannot forge `isTrusted`.
 */
export function installGuestExternalHandoff(host: GuestHandoffHost): void {
  host.addEventListener(
    'click',
    event => {
      if (event.isTrusted !== true || (event.button ?? 0) !== 0) {
        return
      }

      const target = event.target as GuestEventTarget | null

      if (!target || typeof target.closest !== 'function') {
        return
      }

      // `closest` climbs through the click's own DOM, which this isolated
      // preload world shares with the page: an inner `<span>` inside the
      // anchor resolves to the enclosing `<a href>` the same way it would
      // for page script.
      const anchor = target.closest('a[href]')

      if (!anchor || typeof anchor.href !== 'string' || anchor.href === '') {
        return
      }

      // A fragment-only link never leaves this document; opening a tab for
      // it would duplicate an ordinary in-page navigation.
      if ((anchor.getAttribute?.('href') ?? '').startsWith('#')) {
        return
      }

      // `anchor.href` is the browser-resolved absolute URL, not the raw
      // attribute, so relative and protocol-relative hrefs arrive fully
      // qualified for the host's scheme admission check.
      const href = anchor.href
      const before = withoutFragment(host.getLocationHref())

      if (withoutFragment(href) === before) {
        return
      }

      const opensNewContext =
        (typeof anchor.target === 'string' && anchor.target.toLowerCase() === '_blank') ||
        event.shiftKey === true ||
        event.ctrlKey === true ||
        event.metaKey === true

      if (opensNewContext) {
        host.sendToHost(GUEST_EXTERNAL_CHANNEL, href)

        return
      }

      // Portals such as 东方财富 turn ordinary anchors into a `window.open`
      // popup in a page handler. That request is denied (no allowpopups)
      // without touching `defaultPrevented`, so neither the DOM nor Electron's
      // window-open hooks see a link. The gesture is still the user's: only
      // forward when the guest has NOT navigated away after the click.
      host.defer(() => {
        if (withoutFragment(host.getLocationHref()) === before) {
          host.sendToHost(GUEST_EXTERNAL_CHANNEL, href)
        }
      }, NAVIGATION_SETTLE_MS)
    },
    true
  )
}

function withoutFragment(url: string): string {
  const hash = url.indexOf('#')

  return (hash === -1 ? url : url.slice(0, hash)).replace(/\/$/, '')
}
