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

import {
  BTC_CHAIN_ID,
  CROSS_CHAIN_MIN_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  STRICT_CHAIN_MIN_SLIPPAGE_BPS,
  TON_CHAIN_ID
} from './constants.js'
import { ButterActionRequiredError, ButterUnsupportedError } from './errors.js'

/** Context used to apply Butter's route-specific slippage floors. */
export interface SlippageOptions {
  crossChain?: boolean
  sourceChainId?: string | number
  toChainId?: string | number
  strictChainMinimum?: number
}

/** Converts WDK decimal slippage to Butter basis points and enforces minimums. */
export function toButterSlippage (slippage: number | undefined, options: SlippageOptions = {}): number {
  const minimum = minimumSlippageBps(options)
  const explicitBps = slippage == null ? Math.max(DEFAULT_SLIPPAGE_BPS, minimum) : decimalToBps(slippage)
  if (!Number.isFinite(explicitBps) || explicitBps < 0 || explicitBps > 5000) {
    throw new ButterUnsupportedError('slippage must be a decimal between 0 and 0.5')
  }
  if (explicitBps < minimum) {
    throw new ButterActionRequiredError(`Butter requires at least ${minimum} bps slippage for this route`, {
      requestedBps: explicitBps,
      requiredBps: minimum
    })
  }
  return explicitBps
}

/** Returns the minimum Butter slippage in basis points for a route. */
export function minimumSlippageBps (options: SlippageOptions): number {
  const source = normalizeId(options.sourceChainId)
  const destination = normalizeId(options.toChainId)
  const strict = options.strictChainMinimum ?? (
    isStrictChain(source) || isStrictChain(destination) ? STRICT_CHAIN_MIN_SLIPPAGE_BPS : 0
  )
  return Math.max(options.crossChain ? CROSS_CHAIN_MIN_SLIPPAGE_BPS : 0, strict)
}

/**
 * Converts a decimal slippage fraction (e.g. 0.0051 = 0.51%) to integer basis
 * points exactly, via its decimal string rather than `x * 10000` — floating
 * point makes `Math.ceil(0.0051 * 10000)` yield 52. Any precision finer than a
 * basis point rounds up, so the resulting slippage is never below what was
 * requested. Non-finite or negative inputs fall through to the range check in
 * {@link toButterSlippage}.
 */
function decimalToBps (value: number): number {
  if (!Number.isFinite(value) || value < 0) return Math.ceil(value * 10000)
  const text = value.toString()
  // Scientific notation only occurs for tiny positive values here (< ~1e-6, so
  // < 0.01 bp). Round any such non-zero slippage up to 1 bp — never down to 0.
  if (text.includes('e') || text.includes('E')) return Math.ceil(value * 10000)
  const [whole = '0', fraction = ''] = text.split('.')
  const bps = Number(whole) * 10000 + Number(fraction.slice(0, 4).padEnd(4, '0'))
  return /[1-9]/.test(fraction.slice(4)) ? bps + 1 : bps
}

function normalizeId (id: string | number | undefined): string | undefined {
  return id == null ? undefined : String(id).toLowerCase()
}

function isStrictChain (id: string | undefined): boolean {
  return id === BTC_CHAIN_ID || id === TON_CHAIN_ID || id === 'btc' || id === 'ton'
}
