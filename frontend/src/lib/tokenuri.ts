export type PassportMetadata = {
  name: string
  description: string
  image: string
  attributes: { trait_type: string; value: string | number }[]
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(normalized, 'base64').toString('utf8')
  }
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const VALID_NAMES = new Set(['AgentJar Reputation Passport', 'AgentJar Badge'])

/** Decode the full live on-chain Reputation Passport JSON metadata from tokenURI. */
export function parsePassportTokenUri(uri: string): PassportMetadata | null {
  const prefix = 'data:application/json;base64,'
  if (!uri.startsWith(prefix)) return null
  try {
    const json = JSON.parse(decodeBase64(uri.slice(prefix.length))) as {
      name?: unknown
      description?: unknown
      image?: unknown
      attributes?: unknown
    }
    if (typeof json.name !== 'string' || !VALID_NAMES.has(json.name)) return null
    if (typeof json.image !== 'string' || !json.image.startsWith('data:image/svg+xml')) return null
    const attributes = Array.isArray(json.attributes)
      ? json.attributes.filter(
          (item): item is { trait_type: string; value: string | number } =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as { trait_type?: unknown }).trait_type === 'string' &&
            (typeof (item as { value?: unknown }).value === 'string' ||
              typeof (item as { value?: unknown }).value === 'number'),
        )
      : []
    return {
      name: json.name,
      description: typeof json.description === 'string' ? json.description : '',
      image: json.image,
      attributes,
    }
  } catch {
    return null
  }
}

/** Pull the live SVG data URI out of tokenURI. Returns null when metadata is unreadable. */
export function imageSrcFromTokenUri(uri: string): string | null {
  return parsePassportTokenUri(uri)?.image ?? null
}
