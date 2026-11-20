export type TabId = 'tip' | 'badge' | 'polls'

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function appRoot(): string {
  const url = new URL(window.location.href)
  const payPath = url.pathname.match(/^(.*)\/pay\/[^/]+\/?$/)
  const base = payPath ? payPath[1] : url.pathname.replace(/index\.html$/, '').replace(/\/$/, '')
  return `${url.origin}${base}/`
}

/** Query plus hash. Both survive a static export without a dynamic server route. */
export function payUrl(displayHandle: string): string {
  const handle = encodeURIComponent(displayHandle)
  return `${appRoot()}?pay=${handle}#/pay/${handle}`
}

export function readRoute(): { tab: TabId; handle: string | null } {
  const params = new URLSearchParams(window.location.search)
  const queryPay = params.get('pay')
  const hashPay = window.location.hash.match(/^#\/pay\/(.+)$/)
  const pathPay = window.location.pathname.match(/\/pay\/([^/]+)\/?$/)
  const handle =
    queryPay || (hashPay ? safeDecode(hashPay[1]) : null) || (pathPay ? safeDecode(pathPay[1]) : null)
  if (handle) return { tab: 'tip', handle }
  const hash = window.location.hash
  if (hash === '#badge' || hash === '#/badge') return { tab: 'badge', handle: null }
  if (hash === '#polls' || hash === '#/polls') return { tab: 'polls', handle: null }
  return { tab: 'tip', handle: null }
}

export function tabUrl(tab: TabId): string {
  const url = new URL(window.location.href)
  if (tab === 'tip') {
    const pay = url.searchParams.get('pay')
    const hash = pay ? `#/pay/${encodeURIComponent(pay)}` : '#tip'
    return `${url.pathname}${url.search}${hash}`
  }
  url.searchParams.delete('pay')
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ''}#${tab}`
}
