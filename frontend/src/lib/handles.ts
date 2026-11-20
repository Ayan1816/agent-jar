/**
 * Mirrors AgentJar._normalize: lowercase ASCII A-Z, then drop one trailing ".ai".
 * The registry stores the label only, so lookups must use this result.
 */
export function normalizeHandle(raw: string): string {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code >= 0x41 && code <= 0x5a) out += String.fromCharCode(code + 32)
    else out += raw.charAt(index)
  }
  if (out.length >= 3 && out.endsWith('.ai')) out = out.slice(0, -3)
  return out
}

export function displayHandle(normalized: string): string {
  return normalized ? `${normalized}.ai` : ''
}
