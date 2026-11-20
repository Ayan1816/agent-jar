'use client'

import { useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useMounted } from '@/components/useSession'
import { shortOwnWallet } from '@/lib/format'

/** Shows only the connected wallet. Looked-up Agent IDs never render a raw address. */
export function ConnectButton() {
  const mounted = useMounted()
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const [error, setError] = useState<string | null>(null)
  const connector = connectors[0]

  if (!mounted) {
    return (
      <button type="button" className="btn">
        Connect wallet
      </button>
    )
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-white">{shortOwnWallet(address)}</span>
        <button type="button" className="btn-inline" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="text-right">
      <button
        type="button"
        className="btn"
        disabled={!connector || isPending}
        onClick={async () => {
          setError(null)
          try {
            if (!connector) throw new Error('missing connector')
            await connectAsync({ connector })
          } catch (caught) {
            const text = caught instanceof Error ? caught.message : ''
            if (/rejected|denied/i.test(text)) setError('Connection cancelled in the wallet.')
            else setError('No injected wallet was found. Open this page in a browser wallet.')
          }
        }}
      >
        {isPending ? 'Waiting for wallet…' : 'Connect wallet'}
      </button>
      {error ? <p className="mt-1 max-w-56 text-xs text-[#FFD0D0]">{error}</p> : null}
    </div>
  )
}
