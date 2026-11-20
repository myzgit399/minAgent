import { beforeEach, describe, expect, it } from 'vitest'

import {
  $browserAddressHistory,
  browserAddressSuggestions,
  clearBrowserAddressHistory,
  recordBrowserAddress
} from './browser-address-history'

describe('browser address history', () => {
  beforeEach(() => {
    clearBrowserAddressHistory()
  })

  it('records a committed address newest-first and de-duplicates it', () => {
    recordBrowserAddress('https://example.com/docs')
    recordBrowserAddress('https://example.com/next')
    recordBrowserAddress('https://example.com/docs')

    expect($browserAddressHistory.get()).toEqual([
      'https://example.com/docs',
      'https://example.com/next'
    ])
  })

  it('does not record the blank start page', () => {
    recordBrowserAddress('about:blank')

    expect($browserAddressHistory.get()).toEqual([])
  })

  it('filters suggestions by the current draft', () => {
    recordBrowserAddress('https://example.com/docs')
    recordBrowserAddress('https://localhost:5173')
    recordBrowserAddress('https://example.net')

    expect(browserAddressSuggestions($browserAddressHistory.get(), 'example')).toEqual([
      'https://example.net',
      'https://example.com/docs'
    ])
    expect(browserAddressSuggestions($browserAddressHistory.get(), '')).toHaveLength(3)
  })
})
