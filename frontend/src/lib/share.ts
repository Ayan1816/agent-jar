export function badgeTweet(handle: string, tier: string, appUrl: string, mine: boolean): string {
  const line = mine
    ? `I hold the ${tier} AgentJar badge for ${handle}.ai.`
    : `${handle}.ai holds the ${tier} AgentJar badge.`
  return `${line}\n${appUrl}\n#BinanceWalletHackathon #AgenticWallet`
}

export function tweetHref(text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`
}
