function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Pull the live SVG data URI out of tokenURI. Returns null when metadata is unreadable. */
export function imageSrcFromTokenUri(uri: string): string | null {
  const prefix = 'data:application/json;base64,'
  if (!uri.startsWith(prefix)) return null
  try {
    const json = JSON.parse(decodeBase64(uri.slice(prefix.length))) as { image?: unknown; name?: unknown }
    if (json.name !== 'AgentJar Badge') return null
    if (typeof json.image !== 'string' || !json.image.startsWith('data:image/svg+xml')) return null
    return json.image
  } catch {
    return null
  }
}
