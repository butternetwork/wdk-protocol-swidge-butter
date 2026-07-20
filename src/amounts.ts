import { ButterApiError } from './errors.js'

export function parseTokenAmount (amount: string | number | bigint | undefined | null, decimals = 18): bigint {
  assertDecimals(decimals)
  if (amount == null) return 0n
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new ButterApiError(`Invalid token amount: ${amount}`)
    return amount
  }
  if (typeof amount === 'number' && (!Number.isSafeInteger(amount) || amount < 0)) {
    throw new ButterApiError(`Unsafe numeric token amount: ${amount}; use a decimal string`)
  }
  const raw = String(amount).trim()
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new ButterApiError(`Invalid token amount: ${raw}`)
  }
  const [whole = '0', fraction = ''] = raw.split('.')
  const discardedFraction = fraction.slice(decimals)
  if (/[1-9]/.test(discardedFraction)) {
    throw new ButterApiError(`Token amount exceeds ${decimals} decimal places: ${raw}`)
  }
  const normalizedFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || '0')
}

export function formatTokenAmount (amount: bigint | number | string, decimals = 18): string {
  assertDecimals(decimals)
  if (typeof amount === 'number' && (!Number.isSafeInteger(amount) || amount < 0)) {
    throw new ButterApiError(`Unsafe numeric token amount: ${amount}; use bigint base units`)
  }
  const value = BigInt(amount)
  if (value < 0n) throw new ButterApiError(`Invalid token amount: ${amount}`)
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = value % scale
  if (fraction === 0n) return whole.toString()
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`
}

export function parseIntegerAmount (value: string | number | bigint | undefined | null): bigint {
  if (value == null) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterApiError(`Unsafe integer amount: ${value}`)
  }
  const raw = String(value)
  if (raw.startsWith('0x')) return BigInt(raw)
  return BigInt(raw)
}

function assertDecimals (decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Invalid token decimals: ${decimals}`)
  }
}
