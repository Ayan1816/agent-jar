export type TabId = 'tip' | 'bounties' | 'polls' | 'badge' | 'agent-os'

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
  const userPath = url.pathname.match(/^(.*)\/u\/[^/]+\/?$/)
  const base = payPath
    ? payPath[1]
    : userPath
      ? userPath[1]
      : url.pathname.replace(/index\.html$/, '').replace(/\/$/, '')
  return `${url.origin}${base}/`
}

export function payUrl(displayHandle: string): string {
  const handle = encodeURIComponent(displayHandle)
  return `${appRoot()}?pay=${handle}#/pay/${handle}`
}

export function profileUrl(normalizedHandle: string): string {
  return `/u/${encodeURIComponent(normalizedHandle)}`
}

export function readRoute(): { tab: TabId; handle: string | null; bountyWorker: string | null } {
  const params = new URLSearchParams(window.location.search)
  const queryPay = params.get('pay')
  const queryBounty = params.get('bounty')
  const hashPay = window.location.hash.match(/^#\/pay\/(.+)$/)
  const pathPay = window.location.pathname.match(/\/pay\/([^/]+)\/?$/)
  const handle =
    queryPay || (hashPay ? safeDecode(hashPay[1]) : null) || (pathPay ? safeDecode(pathPay[1]) : null)

  if (queryBounty) return { tab: 'bounties', handle: null, bountyWorker: queryBounty }
  if (handle) return { tab: 'tip', handle, bountyWorker: null }

  const hash = window.location.hash
  if (hash === '#bounties' || hash === '#/bounties') return { tab: 'bounties', handle: null, bountyWorker: null }
  if (hash === '#polls' || hash === '#/polls') return { tab: 'polls', handle: null, bountyWorker: null }
  if (hash === '#badge' || hash === '#/badge' || hash === '#passport') {
    return { tab: 'badge', handle: null, bountyWorker: null }
  }
  if (hash === '#agent-os' || hash === '#/agent-os') return { tab: 'agent-os', handle: null, bountyWorker: null }
  return { tab: 'tip', handle: null, bountyWorker: null }
}

export function tabUrl(tab: TabId): string {
  const url = new URL(window.location.href)
  if (tab === 'tip') {
    const pay = url.searchParams.get('pay')
    url.searchParams.delete('bounty')
    const search = url.searchParams.toString()
    const hash = pay ? `#/pay/${encodeURIComponent(pay)}` : '#tip'
    return `${url.pathname}${search ? `?${search}` : ''}${hash}`
  }
  if (tab === 'bounties') {
    url.searchParams.delete('pay')
    const search = url.searchParams.toString()
    return `${url.pathname}${search ? `?${search}` : ''}#bounties`
  }
  url.searchParams.delete('pay')
  url.searchParams.delete('bounty')
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ''}#${tab}`
}
