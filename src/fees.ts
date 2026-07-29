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

import { NATIVE_TOKEN_ADDRESSES, SOLANA_CHAIN_ID, BTC_CHAIN_ID, TRON_CHAIN_ID } from './constants.js'
import { parseTokenAmount } from './amounts.js'
import {
  ButterApiError,
  ButterConfigurationError,
  ButterFeeLimitExceededError,
  ButterFeeValuationError
} from './errors.js'
import type {
  ButterBridgeFee,
  ButterRoute,
  ButterRouteToken,
  SwidgeFee,
  SwidgeProtocolConfig
} from './types.js'

const USD_DECIMALS = 18
const BPS_DENOMINATOR = 10000n

/** Chain and token context required to parse Butter route fees. */
export interface FeeContext {
  sourceChainId: string
  sourceToken: string
  nativeTokenDecimals?: Record<string, number>
  /**
   * The caller's exact input in source-token base units. Used as the denominator
   * for source-denominated fee caps so an inflated route-reported input cannot
   * understate the ratio and bypass a bps limit. Required when a source-token
   * fee cap is enforced.
   */
  requestedAmountIn?: bigint
}

/** Effective WDK fee limits after constructor and per-call precedence. */
export interface ResolvedFeeLimits {
  maxNetworkFeeBps?: bigint
  maxProtocolFeeBps?: bigint
}

interface Ratio {
  numerator: bigint
  denominator: bigint
}

/** Resolves and validates constructor and per-call WDK fee limits. */
export function resolveFeeLimits (
  defaults: SwidgeProtocolConfig,
  overrides: SwidgeProtocolConfig
): ResolvedFeeLimits {
  const network = overrides.maxNetworkFeeBps ?? defaults.maxNetworkFeeBps
  const protocol = overrides.maxProtocolFeeBps ?? defaults.maxProtocolFeeBps
  const result: ResolvedFeeLimits = {}
  if (network != null) result.maxNetworkFeeBps = parseBps(network, 'maxNetworkFeeBps')
  if (protocol != null) result.maxProtocolFeeBps = parseBps(protocol, 'maxProtocolFeeBps')
  return result
}

/** Validates configured fee limits eagerly, rejecting malformed bps values. */
export function validateFeeLimits (config: SwidgeProtocolConfig): void {
  resolveFeeLimits(config, {})
}

/**
 * Maps Butter fee metadata into WDK fee entries using denomination-specific decimals.
 *
 * NOTE (upstream WDK contract): the base SwidgeProtocol's legacy `swap()` and
 * `bridge()` sum `fees[].amount` across entries regardless of denomination.
 * Butter fees can be denominated in different tokens (native, input token,
 * bridge token), so the legacy aggregated `fee` / `bridgeFee` have no coherent
 * unit when denominations differ. Consumers needing correct per-currency costs
 * must read the itemised `fees[]` on the SwidgeQuote/SwidgeResult, not the
 * legacy scalars. This cannot be fixed here without overriding legacy methods
 * (which providers must not do); it needs a WDK PR #39 mapping-contract change.
 */
export function mapRouteFees (route: ButterRoute, context: FeeContext): SwidgeFee[] {
  const fees: SwidgeFee[] = []
  const sourceToken = route.srcChain?.tokenIn
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)

  if (isNonZero(route.bridgeFee?.amount)) {
    const token = bridgeFeeToken(route)
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.bridgeFee?.amount, requiredDecimals(token, 'bridge fee')),
      token: requiredTokenId(route.bridgeFee?.address ?? token?.address ?? route.bridgeFee?.symbol ?? token?.symbol, 'bridge fee'),
      chain: route.bridgeFee?.chainId,
      included: true,
      description: 'Butter bridge fee'
    })
  }
  if (isNonZero(route.bridgeFee?.affiliate?.amount)) {
    const token = route.bridgeFee?.affiliate?.token
    fees.push({
      type: 'affiliate',
      amount: parseTokenAmount(route.bridgeFee?.affiliate?.amount, requiredDecimals(token, 'affiliate fee')),
      token: requiredTokenId(token?.address ?? token?.symbol, 'affiliate fee'),
      chain: route.bridgeFee?.chainId,
      included: true,
      description: 'Butter affiliate fee'
    })
  }
  if (isNonZero(route.gasFee?.amount)) {
    fees.push({
      type: 'network',
      amount: parseTokenAmount(route.gasFee?.amount, nativeDecimals),
      token: requiredTokenId(route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context), 'network fee'),
      chain: route.gasFee?.chainId ?? context.sourceChainId,
      included: false,
      description: 'Estimated source chain gas fee'
    })
  }
  if (isNonZero(route.swapFee?.nativeFee)) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.swapFee?.nativeFee, nativeDecimals),
      token: requiredTokenId(
        route.swapFee?.nativeSymbol ?? route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context),
        'native protocol fee'
      ),
      chain: context.sourceChainId,
      included: false,
      description: 'Butter native swap fee'
    })
  }
  if (isNonZero(route.swapFee?.tokenFee)) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.swapFee?.tokenFee, requiredDecimals(sourceToken, 'token protocol fee')),
      token: requiredTokenId(sourceToken?.address ?? context.sourceToken ?? route.swapFee?.tokenSymbol, 'token protocol fee'),
      chain: context.sourceChainId,
      included: true,
      description: 'Butter token swap fee'
    })
  }
  return fees
}

/**
 * Returns the route's additional native protocol fee in source-chain base units.
 *
 * Rounds up: this value is the quoted side of an upper bound on `tx.value`
 * (`swap-data.ts`), so rounding down would turn a sub-wei formatting artifact in
 * Butter's decimal string into a rejected transaction. Rounding up can only widen
 * the bound by one wei, and the absolute `maxNativeFee` cap is unaffected.
 */
export function routeNativeFee (route: ButterRoute, context: FeeContext): bigint {
  return parseTokenAmount(
    route.swapFee?.nativeFee ?? '0',
    nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals),
    { rounding: 'ceil' }
  )
}

/** Enforces WDK network and protocol fee caps before transaction construction. */
export function enforceFeeLimits (
  route: ButterRoute,
  context: FeeContext,
  limits: ResolvedFeeLimits
): void {
  if (limits.maxNetworkFeeBps != null) {
    enforceLimit('network', networkFeeRatios(route, context), limits.maxNetworkFeeBps)
  }
  if (limits.maxProtocolFeeBps != null) {
    enforceLimit('protocol', protocolFeeRatios(route, context), limits.maxProtocolFeeBps)
  }
}

function networkFeeRatios (route: ButterRoute, context: FeeContext): Ratio[] {
  if (!isNonZero(route.gasFee?.amount)) return []
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)
  const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals)
  if (isNativeSource(context.sourceToken)) {
    return [{ numerator: gasAmount, denominator: sourceDenominator(context) }]
  }
  return [usdRatio(route.gasFee?.inUSD, route.totalAmountInUSD, 'network fee')]
}

function protocolFeeRatios (route: ButterRoute, context: FeeContext): Ratio[] {
  const ratios: Ratio[] = []
  const sourceToken = route.srcChain?.tokenIn
  const sourceDecimals = requiredDecimals(sourceToken, 'source token')
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)

  if (isNonZero(route.swapFee?.tokenFee)) {
    ratios.push({
      numerator: parseTokenAmount(route.swapFee?.tokenFee, sourceDecimals),
      denominator: sourceDenominator(context)
    })
  }
  if (isNonZero(route.swapFee?.nativeFee)) {
    const nativeFee = parseTokenAmount(route.swapFee?.nativeFee, nativeDecimals)
    if (isNativeSource(context.sourceToken)) {
      ratios.push({ numerator: nativeFee, denominator: sourceDenominator(context) })
    } else {
      const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals)
      const gasUsd = parseUsd(route.gasFee?.inUSD, 'native protocol fee')
      const inputUsd = parseUsd(route.totalAmountInUSD, 'native protocol fee')
      if (gasAmount === 0n) throw new ButterFeeValuationError('Cannot value Butter native protocol fee without a nonzero gas fee')
      ratios.push({ numerator: nativeFee * gasUsd, denominator: gasAmount * inputUsd })
    }
  }
  if (isNonZero(route.bridgeFee?.amount)) {
    ratios.push(bridgeFeeRatio(route))
  }
  return ratios
}

function bridgeFeeRatio (route: ButterRoute): Ratio {
  const token = bridgeFeeToken(route)
  const decimals = requiredDecimals(token, 'bridge fee')
  const numerator = parseTokenAmount(route.bridgeFee?.amount, decimals)
  const candidates: Array<{ token: ButterRouteToken | undefined, amount: string | undefined }> = [
    { token: route.bridgeChain?.tokenIn, amount: route.bridgeChain?.totalAmountIn },
    { token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut },
    { token: route.srcChain?.tokenIn, amount: route.srcChain?.totalAmountIn }
  ]
  const denominator = candidates.find((candidate) => sameToken(candidate.token, token) && candidate.amount != null)
  if (!denominator?.amount) {
    throw new ButterFeeValuationError('Cannot value Butter bridge fee against a matching route amount')
  }
  return { numerator, denominator: parseTokenAmount(denominator.amount, decimals) }
}

function enforceLimit (type: 'network' | 'protocol', ratios: Ratio[], maximumBps: bigint): void {
  let total: Ratio = { numerator: 0n, denominator: 1n }
  for (const ratio of ratios) {
    if (ratio.denominator <= 0n) throw new ButterFeeValuationError(`Cannot value Butter ${type} fee against a zero amount`)
    total = {
      numerator: total.numerator * ratio.denominator + ratio.numerator * total.denominator,
      denominator: total.denominator * ratio.denominator
    }
  }
  if (total.numerator * BPS_DENOMINATOR > maximumBps * total.denominator) {
    const actualBps = (total.numerator * BPS_DENOMINATOR + total.denominator - 1n) / total.denominator
    throw new ButterFeeLimitExceededError(type, actualBps, maximumBps)
  }
}

function usdRatio (feeUsd: string | undefined, inputUsd: string | undefined, label: string): Ratio {
  return {
    numerator: parseUsd(feeUsd, label),
    denominator: parseUsd(inputUsd, label)
  }
}

function parseUsd (value: string | undefined, label: string): bigint {
  if (value == null) throw new ButterFeeValuationError(`Cannot value Butter ${label} without USD metadata`)
  return parseTokenAmount(value, USD_DECIMALS)
}

/**
 * Denominator for source-denominated fee caps: the caller's exact input, NOT the
 * route-reported `srcChain.totalAmountIn` (which is untrusted and, if inflated,
 * would understate the ratio and let an over-cap fee pass).
 */
function sourceDenominator (context: FeeContext): bigint {
  if (context.requestedAmountIn == null) {
    throw new ButterFeeValuationError('Cannot value a source-denominated Butter fee without the requested input amount')
  }
  return context.requestedAmountIn
}

function bridgeFeeToken (route: ButterRoute): ButterRouteToken | undefined {
  const fee = route.bridgeFee
  const candidates = [fee?.out?.token, fee?.in?.token, route.bridgeChain?.tokenOut, route.bridgeChain?.tokenIn, route.srcChain?.tokenOut]
  return candidates.find((token) => tokenMatchesFee(token, fee)) ?? candidates.find((token) => token != null)
}

function tokenMatchesFee (token: ButterRouteToken | undefined, fee: ButterBridgeFee | undefined): boolean {
  if (!token || !fee) return false
  if (fee.address && token.address) return fee.address.toLowerCase() === token.address.toLowerCase()
  if (fee.symbol && token.symbol) return fee.symbol.toLowerCase() === token.symbol.toLowerCase()
  return false
}

function sameToken (left: ButterRouteToken | undefined, right: ButterRouteToken | undefined): boolean {
  if (!left || !right) return false
  if (left.address && right.address) return left.address.toLowerCase() === right.address.toLowerCase()
  return Boolean(left.symbol && right.symbol && left.symbol.toLowerCase() === right.symbol.toLowerCase())
}

function requiredDecimals (token: ButterRouteToken | undefined, label: string): number {
  const decimals = Number(token?.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Butter ${label} is missing valid token decimals`)
  }
  return decimals
}

function requiredTokenId (value: string | undefined, label: string): string {
  const token = value?.trim()
  if (!token) throw new ButterApiError(`Butter ${label} is missing a token identifier`)
  return token
}

function nativeTokenId (context: FeeContext): string | undefined {
  return isNativeSource(context.sourceToken) ? context.sourceToken : undefined
}

/** Resolves source-chain native token decimals with caller overrides. */
export function nativeDecimalsForChain (chainId: string, configured: Record<string, number> | undefined): number {
  const configuredValue = configured?.[chainId]
  if (configuredValue != null) return configuredValue
  if (chainId === TRON_CHAIN_ID) return 6
  if (chainId === BTC_CHAIN_ID) return 8
  if (chainId === SOLANA_CHAIN_ID) return 9
  return 18
}

function isNativeSource (token: string): boolean {
  return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase())
}

function isNonZero (value: string | number | bigint | undefined): boolean {
  if (value == null) return false
  const raw = String(value).trim()
  return !/^0+(?:\.0+)?$/.test(raw)
}

function parseBps (value: number | bigint, field: string): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  }
  const result = BigInt(value)
  if (result < 0n) throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  return result
}
