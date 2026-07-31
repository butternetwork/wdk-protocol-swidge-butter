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

import { parseRequiredTokenAmount, parseTokenAmount } from './amounts.js'
import { mapRouteFees, type FeeContext } from './fees.js'
import { decimalsOf } from './route.js'
import type {
  ButterChainExecution,
  ButterChainInfo,
  ButterRoute,
  ButterSupportedChain,
  ButterTokenInfo,
  SwidgeQuote,
  SwidgeSupportedToken
} from './types.js'

/**
 * Builds a WDK quote from a Butter route.
 *
 * For exact-in the caller passes `requestedAmountIn` (the base-unit input the
 * user asked for); the quote echoes it verbatim so `fromTokenAmount` can never
 * drift from the request due to a decimals-source mismatch. Output amounts use
 * the route-echoed destination decimals, which must be present.
 */
export function routeToQuote (route: ButterRoute, now: () => number, expiry: number | undefined, feeContext: FeeContext, requestedAmountIn?: number | bigint): SwidgeQuote {
  const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut, 'destination token')
  const toTokenAmountMin = parseRequiredTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, 'minimum output amount', destinationDecimals)
  const fromTokenAmount = requestedAmountIn != null
    ? BigInt(requestedAmountIn)
    : parseTokenAmount(route.srcChain?.totalAmountIn ?? route.totalAmountIn, decimalsOf(route.srcChain?.tokenIn, 'source token'))
  return {
    fromTokenAmount,
    toTokenAmount: parseRequiredTokenAmount(
      route.dstChain != null ? route.dstChain.totalAmountOut : route.srcChain?.totalAmountOut,
      'destination total output amount',
      destinationDecimals
    ),
    toTokenAmountMin,
    fees: mapRouteFees(route, feeContext),
    estimatedDuration: finiteOrUndefined(route.timeEstimated ?? route.estimatedTime),
    expiry: expiry ?? now() + 300,
    // Butter only reports priceImpact per route leg (dstChain/srcChain `route[]`),
    // with no documented unit or whole-operation aggregation. Picking one leg would
    // misrepresent a multi-leg (e.g. both-ends swap) operation, so we only surface a
    // value when Butter provides an authoritative top-level one; otherwise undefined.
    // WDK expects a decimal price impact — confirm Butter's unit/aggregation before
    // deriving one from the per-leg values.
    priceImpact: finiteOrUndefined(route.priceImpact)
  }
}

/** Returns a finite number, or undefined when the value is absent or unparseable. */
function finiteOrUndefined (value: string | number | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function chainToSupportedChain (chain: ButterChainInfo, execution: ButterChainExecution): ButterSupportedChain {
  const nativeToken = parseJsonMaybe<ButterTokenInfo>(chain.nativeToken)
  return {
    id: normalizeId(chain.chainId ?? chain.id),
    name: chain.name ?? normalizeId(chain.chainId ?? chain.id),
    // WDK requires both `type` and `nativeToken`, so a missing value becomes an
    // empty string rather than a plausible-looking placeholder ('unknown' reads
    // as a real chain type): the discovery caller drops such entries, exactly as
    // it does for a token whose decimals are missing.
    type: String(chain.chainType ?? chain.type ?? '').toLowerCase(),
    nativeToken: nativeToken?.symbol ?? '',
    execution
  }
}

export function tokenToSupportedToken (token: ButterTokenInfo, chainId: string): SwidgeSupportedToken {
  return {
    token: token.address ?? token.token ?? '',
    chain: normalizeId(token.chainId ?? chainId),
    symbol: token.symbol ?? '',
    // Missing decimals yields NaN (not a silent 18); the discovery caller drops
    // such entries so a placeholder value is never surfaced as if authoritative.
    decimals: Number(token.decimals ?? token.decimal),
    address: token.address ?? token.token,
    name: token.name
  }
}

export function parseJsonMaybe<T> (value: unknown): T | undefined {
  if (typeof value !== 'string') return value as T | undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function normalizeId (id: string | number | undefined): string {
  return id == null ? '' : String(id)
}
