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

import { parseTokenAmount } from './amounts.js'
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
  const toTokenAmountMin = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals)
  const fromTokenAmount = requestedAmountIn != null
    ? BigInt(requestedAmountIn)
    : parseTokenAmount(route.srcChain?.totalAmountIn ?? route.totalAmountIn, decimalsOf(route.srcChain?.tokenIn, 'source token'))
  return {
    fromTokenAmount,
    toTokenAmount: parseTokenAmount(route.dstChain?.totalAmountOut ?? route.srcChain?.totalAmountOut ?? route.totalAmountOut, destinationDecimals),
    toTokenAmountMin,
    fees: mapRouteFees(route, feeContext),
    estimatedDuration: Number(route.timeEstimated ?? route.estimatedTime ?? 0),
    expiry: expiry ?? now() + 300,
    priceImpact: route.priceImpact == null ? undefined : Number(route.priceImpact)
  }
}

export function chainToSupportedChain (chain: ButterChainInfo, execution: ButterChainExecution): ButterSupportedChain {
  const nativeToken = parseJsonMaybe<ButterTokenInfo>(chain.nativeToken)
  return {
    id: normalizeId(chain.chainId ?? chain.id),
    name: chain.name ?? normalizeId(chain.chainId ?? chain.id),
    type: String(chain.chainType ?? chain.type ?? 'unknown').toLowerCase(),
    nativeToken: nativeToken?.symbol ?? '',
    execution
  }
}

export function tokenToSupportedToken (token: ButterTokenInfo, chainId: string): SwidgeSupportedToken {
  return {
    token: token.address ?? token.token ?? '',
    chain: normalizeId(token.chainId ?? chainId),
    symbol: token.symbol ?? '',
    decimals: Number(token.decimals ?? token.decimal ?? 18),
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
