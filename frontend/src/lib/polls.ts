export const DURATIONS = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { label: '14 days', seconds: 14 * 24 * 60 * 60 },
  { label: '30 days', seconds: 30 * 24 * 60 * 60 },
] as const

export const MIN_POLL_DURATION = 60 * 60
export const MAX_POLL_DURATION = 30 * 24 * 60 * 60

export function parseOptions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function pollFormError(question: string, optionsText: string, duration: number): string | null {
  if (question.trim().length === 0) return 'Enter a question.'
  const options = parseOptions(optionsText)
  if (options.length < 2 || options.length > 6) return 'Enter 2 to 6 options, one per line.'
  if (duration < MIN_POLL_DURATION || duration > MAX_POLL_DURATION) {
    return 'Duration must be from 1 hour to 30 days.'
  }
  return null
}
