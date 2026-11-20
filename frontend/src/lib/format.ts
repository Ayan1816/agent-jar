import { parseEther } from 'viem'
import { MAX_MESSAGE_BYTES } from '@/lib/config'

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  return `${safe.toLocaleString('en-US')} ${safe === 1 ? singular : plural}`
}

export function supportLine(supporters: number, tips: number): string {
  return `${countLabel(supporters, 'supporter')} · ${countLabel(tips, 'tip')}`
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function messageTooLong(text: string): boolean {
  return utf8Bytes(text) > MAX_MESSAGE_BYTES
}

export function parseTipAmount(input: string): bigint | null {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed) && !/^\.\d+$/.test(trimmed)) return null
  const normalized = trimmed.startsWith('.') ? `0${trimmed}` : trimmed
  try {
    return parseEther(normalized)
  } catch {
    return null
  }
}

export function formatUnitsTrim(value: bigint, decimals = 18, maxFrac = 4): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = absolute / base
  let fraction = (absolute % base).toString().padStart(decimals, '0').slice(0, maxFrac)
  fraction = fraction.replace(/0+$/, '')
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = fraction ? `${wholeText}.${fraction}` : wholeText
  return negative ? `-${text}` : text
}

export function timeLeft(endTimeSec: number, nowSec: number): string {
  const delta = endTimeSec - nowSec
  if (delta <= 0) return 'Ended'
  const day = 86_400
  const hour = 3_600
  const minute = 60
  if (delta >= day) {
    const days = Math.floor(delta / day)
    const hours = Math.floor((delta % day) / hour)
    const dayPart = days === 1 ? '1 day' : `${days} days`
    if (hours === 0) return `${dayPart} left`
    const hourPart = hours === 1 ? '1 hour' : `${hours} hours`
    return `${dayPart} ${hourPart} left`
  }
  if (delta >= hour) {
    const hours = Math.floor(delta / hour)
    return hours === 1 ? '1 hour left' : `${hours} hours left`
  }
  if (delta >= minute) {
    const minutes = Math.floor(delta / minute)
    return minutes === 1 ? '1 minute left' : `${minutes} minutes left`
  }
  return 'Less than 1 minute left'
}

export function dayIndex(nowSec = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSec / 86_400) + 1
}

export function pollsLeftToday(pollDay: number, pollsToday: number, nowSec = Math.floor(Date.now() / 1000)): number {
  const used = pollDay === dayIndex(nowSec) ? pollsToday : 0
  return Math.max(0, 3 - used)
}

export function shortOwnWallet(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
