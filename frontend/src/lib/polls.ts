export const DURATIONS = [
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '12 hours', seconds: 12 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
] as const

export const MIN_POLL_DURATION = 6 * 60 * 60
export const MAX_POLL_DURATION = 7 * 24 * 60 * 60
export const MAX_QUESTION_BYTES = 200
export const MAX_OPTION_BYTES = 64

function byteLen(value: string): number {
  return new TextEncoder().encode(value).length
}

export function parseOptions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function pollFormError(question: string, optionsText: string, duration: number): string | null {
  const trimmed = question.trim()
  if (trimmed.length === 0) return 'Enter a question.'
  if (byteLen(trimmed) > MAX_QUESTION_BYTES) return `Question must be at most ${MAX_QUESTION_BYTES} bytes.`
  const options = parseOptions(optionsText)
  if (options.length < 2 || options.length > 6) return 'Enter 2 to 6 options, one per line.'
  if (options.some((opt) => byteLen(opt) > MAX_OPTION_BYTES)) {
    return `Each option must be at most ${MAX_OPTION_BYTES} bytes.`
  }
  if (duration < MIN_POLL_DURATION || duration > MAX_POLL_DURATION) {
    return 'Duration must be from 6 hours to 7 days.'
  }
  return null
}
