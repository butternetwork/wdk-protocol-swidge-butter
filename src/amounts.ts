// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ButterApiError, ButterUnsupportedError } from './errors.js'

/**
 * What to do when a decimal amount carries more precision than the token's
 * `decimals` can represent. `reject` (the default) refuses the value rather than
 * silently losing precision; `floor`/`ceil` are for values where a deliberate
 * rounding direction is safe — pick the direction that cannot favour the
 * counterparty (e.g. `ceil` for an amount that will be compared as an upper bound).
 */
export type TokenAmountRounding = 'reject' | 'floor' | 'ceil'

export interface ParseTokenAmountOptions {
  rounding?: TokenAmountRounding
}

/** Converts a non-negative decimal token amount into integer base units. */
export function parseTokenAmount (
  amount: string | number | bigint | undefined | null,
  decimals = 18,
  options: ParseTokenAmountOptions = {}
): bigint {
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
  const rounding = options.rounding ?? 'reject'
  const losesPrecision = /[1-9]/.test(fraction.slice(decimals))
  if (losesPrecision && rounding === 'reject') {
    throw new ButterApiError(`Token amount exceeds ${decimals} decimal places: ${raw}`)
  }
  const normalizedFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  const truncated = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || '0')
  return losesPrecision && rounding === 'ceil' ? truncated + 1n : truncated
}

/** Formats integer base units as a decimal token amount without floating point conversion. */
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

/**
 * Parses a decimal or hexadecimal integer amount returned by Butter.
 *
 * `BigInt` already accepts a `0x` prefix, so there is no separate hex branch. The
 * negative check applies to every input form: a `"-1"` string used to pass here
 * and only fail later in an equality comparison, which pointed the error at the
 * wrong cause.
 */
export function parseIntegerAmount (value: string | number | bigint | undefined | null): bigint {
  if (value == null) return 0n
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterApiError(`Unsafe integer amount: ${value}`)
  }
  const result = typeof value === 'bigint' ? value : BigInt(String(value).trim())
  if (result < 0n) throw new ButterApiError(`Invalid integer amount: ${value}`)
  return result
}

export interface BaseUnitAmountOptions {
  /** Accept `0`; the default requires a strictly positive amount. */
  allowZero?: boolean
}

/**
 * Validates a caller-supplied base-unit amount from the WDK `number | bigint` union.
 *
 * WDK declares these as `number | bigint`, so an out-of-range `number` (e.g. `1e20`)
 * reaches `BigInt()` and throws a raw `RangeError` that names neither the field nor
 * this package. Every caller-facing amount goes through here so the diagnostics are
 * uniform: `fromTokenAmount`, `toTokenAmount`, `minAmountOut`, `maxFromTokenAmount`.
 *
 * Throws `ButterUnsupportedError` (not `ButterApiError`) because the value came from
 * the caller, not from Butter — this is the type `assertQuoteOptions` already used.
 */
export function assertBaseUnitAmount (
  value: number | bigint | undefined | null,
  field: string,
  options: BaseUnitAmountOptions = {}
): bigint {
  if (value == null) throw new ButterUnsupportedError(`${field} is required as an integer in base units`)
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new ButterUnsupportedError(`${field} must use bigint base units when it exceeds safe integer precision`)
  }
  let result: bigint
  try {
    result = BigInt(value)
  } catch (cause) {
    throw new ButterUnsupportedError(`${field} must be an integer in base units`, { cause })
  }
  if (result < 0n || (result === 0n && options.allowZero !== true)) {
    throw new ButterUnsupportedError(
      options.allowZero === true
        ? `${field} must not be negative`
        : `${field} must be greater than zero`
    )
  }
  return result
}

function assertDecimals (decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Invalid token decimals: ${decimals}`)
  }
}
