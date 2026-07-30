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
  NATIVE_TOKEN_ADDRESSES,
  ROUTE_CACHE_MAX_ENTRIES,
  ROUTE_EXECUTION_MARGIN_SECONDS,
  ROUTE_EXPIRY_MARGIN_SECONDS,
  ROUTE_TTL_SECONDS,
  SOLANA_CHAIN_ID,
  STRICT_CHAIN_MIN_SLIPPAGE_BPS
} from './constants.js'
import { nativeDecimalsForChain } from './fees.js'
import {
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterNoRouteError
} from './errors.js'
import { assertBaseUnitAmount, formatTokenAmount, parseTokenAmount } from './amounts.js'
import { toButterSlippage } from './slippage.js'
import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js'

export interface RouteRequestContext {
  sourceChainId: string
  entrance: string
  now: () => number
  tokenDecimals: Record<string, number>
  nativeTokenDecimals: Record<string, number>
  strictSlippageChainIds: Set<string>
  /**
   * Seconds of remaining route lifetime required on the execution path, covering
   * the `/swap` round-trip and the approval wait that still follow. Defaults to
   * {@link ROUTE_EXECUTION_MARGIN_SECONDS}.
   */
  executionMarginSeconds?: number
  /**
   * Butter affiliate string (`<nickname>[:rate]`) collecting the integrator's
   * share. Butter substitutes **its own** default affiliate wallet when this is
   * absent, and the user pays either way — so leaving it unset is a choice to
   * forgo the share, not a way to avoid the fee. Validated at construction.
   */
  affiliate?: string
  /** Butter referrer. Mandatory for Solana same-chain routes, optional on EVM. */
  referrer?: string
  requestRoute: (params: Record<string, unknown>) => Promise<ButterRoute[] | ButterRoute>
  /** Optional fallback resolving decimals for tokens absent from `tokenDecimals`. */
  lookupDecimals?: (token: string) => Promise<number | undefined>
}

export class RouteManager {
  private readonly context: RouteRequestContext
  private readonly cache = new Map<string, CachedRoute>()
  // Secondary index (route hash -> cache key) so a caller can pin an approved
  // quote by its Butter route hash. Kept in sync with `cache` on set/evict.
  private readonly hashIndex = new Map<string, string>()

  constructor (context: RouteRequestContext) {
    this.context = context
  }

  private executionMargin (): number {
    return this.context.executionMarginSeconds ?? ROUTE_EXECUTION_MARGIN_SECONDS
  }

  async getRoute (options: SwidgeOptions, { forExecution = false, senderFallback }: { forExecution?: boolean, senderFallback?: string | undefined } = {}): Promise<CachedRoute> {
    const request = await this.buildRouteRequest(options, senderFallback)
    const key = stableRouteKey(request, options)
    const cached = this.cache.get(key)
    // Execution needs a far larger margin than a quote: a route that is merely
    // "not expired yet" still has to survive the /swap round-trip and the
    // approval wait before it lands on-chain.
    const margin = forExecution ? this.executionMargin() : ROUTE_EXPIRY_MARGIN_SECONDS
    if (cached) {
      // The execution path consumes a cached route whether or not it is fresh
      // enough to use, so a stale entry is never left behind for a later call.
      if (forExecution) this.evict(key, cached)
      if (cached.expiresAt - margin > this.context.now()) return cached
    }

    const response = await this.context.requestRoute(request)
    // Butter returns candidates ordered best-output-first, so the first liquid one
    // is still the best available. Taking `[0]` unconditionally failed the whole
    // request whenever the top candidate happened to lack liquidity.
    const route = Array.isArray(response)
      ? response.find((candidate) => candidate != null && candidate.hasLiquidity !== false)
      : response
    if (!route || route.hasLiquidity === false) {
      throw new ButterNoRouteError('Butter router returned no liquid route', response)
    }
    // Runs on whichever candidate was chosen: falling back to a later one must not
    // skip the chain/token consistency checks.
    this.validateRouteMatchesRequest(route, request)
    const cachedRoute = {
      key,
      route,
      slippageBps: Number(request.slippage),
      expiresAt: routeExpiresAt(route, this.context.now())
    }
    if (!forExecution) {
      this.evictStaleRoutes()
      this.cache.set(key, cachedRoute)
      this.hashIndex.set(route.hash, key)
    }
    return cachedRoute
  }

  /**
   * Consumes a previously quoted route pinned by its Butter hash.
   *
   * Returns the cached route (removing it) only when it is still fresh enough to
   * execute and its request matches the current options; otherwise throws so the
   * caller re-quotes rather than silently executing a different or stale price.
   *
   * A pin is the caller's approved price, so a route inside the execution margin
   * cannot be silently re-fetched the way {@link getRoute} does — that would
   * execute a price the caller never saw. It is rejected instead.
   */
  async consumeRouteByHash (hash: string, options: SwidgeOptions, senderFallback?: string): Promise<CachedRoute> {
    const request = await this.buildRouteRequest(options, senderFallback)
    const key = stableRouteKey(request, options)
    const indexedKey = this.hashIndex.get(hash)
    const entry = indexedKey ? this.cache.get(indexedKey) : undefined
    const usableUntil = this.context.now() + this.executionMargin()
    if (!entry || entry.key !== key || entry.route.hash !== hash || entry.expiresAt <= usableUntil) {
      if (indexedKey) this.cache.delete(indexedKey)
      this.hashIndex.delete(hash)
      throw new ButterActionRequiredError('Pinned Butter quote expires too soon to execute or does not match the request; request a new quote', { hash })
    }
    this.cache.delete(entry.key)
    this.hashIndex.delete(hash)
    return entry
  }

  /**
   * Bounds cache growth for long-lived quote-only instances: drops expired
   * entries, then evicts oldest (insertion-ordered) entries until under the cap.
   */
  private evictStaleRoutes (): void {
    const now = this.context.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.evict(key, entry)
    }
    while (this.cache.size >= ROUTE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.cache.get(oldestKey)
      if (oldest) this.evict(oldestKey, oldest)
      else this.cache.delete(oldestKey)
    }
  }

  private evict (key: string, entry: CachedRoute): void {
    this.cache.delete(key)
    if (this.hashIndex.get(entry.route.hash) === key) this.hashIndex.delete(entry.route.hash)
  }

  async buildRouteRequest (options: SwidgeOptions, senderFallback?: string): Promise<Record<string, unknown>> {
    const toChainId = normalizeId(options.toChain ?? this.context.sourceChainId)
    const isSolanaSource = this.context.sourceChainId === SOLANA_CHAIN_ID
    // Butter requires an explicit receiver for Solana source. Honor the WDK
    // default (recipient defaults to the account/sender) using senderFallback
    // when available, instead of rejecting a resolvable request.
    const solanaReceiver = options.recipient ?? senderFallback
    if (isSolanaSource && !solanaReceiver) {
      throw new ButterActionRequiredError('Butter requires receiver when source chain is Solana')
    }
    // Butter documents `referrer` as mandatory for Solana same-chain routes.
    // Without it the request can never be valid, so fail with a configuration
    // error rather than forwarding a request Butter is bound to reject.
    if (isSolanaSource && toChainId === SOLANA_CHAIN_ID && !this.context.referrer) {
      throw new ButterConfigurationError('Butter requires a referrer for Solana same-chain routes; set config.referrer')
    }
    // Exact-in only: `assertQuoteOptions` rejects exact-out before any request
    // reaches here (see the errno 2000 note there). Butter documents `amount` as
    // "amount of source token", which is what this sends.
    if (!('fromTokenAmount' in options) || options.fromTokenAmount == null) {
      throw new ButterExactOutUnsupportedError()
    }
    const amount = formatTokenAmount(options.fromTokenAmount, await this.decimalsFor(options.fromToken))
    const strictChain = this.context.strictSlippageChainIds.has(this.context.sourceChainId) || this.context.strictSlippageChainIds.has(toChainId)
    const slippage = toButterSlippage(options.slippage, {
      crossChain: toChainId !== this.context.sourceChainId,
      sourceChainId: this.context.sourceChainId,
      toChainId,
      ...(strictChain ? { strictChainMinimum: STRICT_CHAIN_MIN_SLIPPAGE_BPS } : {})
    })

    return {
      fromChainId: this.context.sourceChainId,
      toChainId,
      amount,
      tokenInAddress: options.fromToken,
      tokenOutAddress: options.toToken,
      type: 'exactIn',
      slippage,
      // Only Solana needs the sender-derived fallback; other chains keep the
      // explicit recipient (possibly undefined) so the cache key stays stable.
      receiver: isSolanaSource ? solanaReceiver : options.recipient,
      entrance: this.context.entrance,
      // Spread conditionally so an unconfigured integrator's cache key (and the
      // outgoing query) stay exactly as they were before these were added.
      // Both participate in `stableRouteKey`, so changing the affiliate cannot
      // hit a route cached under the previous one.
      ...(this.context.affiliate ? { affiliate: this.context.affiliate } : {}),
      ...(this.context.referrer ? { referrer: this.context.referrer } : {})
    }
  }

  enforceMinAmountOut (options: SwidgeOptions, route: ButterRoute): void {
    if (options.minAmountOut == null) return
    // Validated like `fromTokenAmount`: WDK types this as `number | bigint`, so an
    // out-of-range number reached `BigInt()` and threw a raw RangeError. Zero is a
    // meaningful request here ("no minimum"), unlike an input amount.
    const requested = assertBaseUnitAmount(options.minAmountOut, 'minAmountOut', { allowZero: true })
    const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut, 'destination token')
    const routeMinimum = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals)
    if (routeMinimum < requested) {
      throw new ButterActionRequiredError('Butter route minimum output is below requested minAmountOut', {
        requestedMinAmountOut: String(requested),
        routeMinimum: String(routeMinimum)
      })
    }
  }

  private async decimalsFor (token: string): Promise<number> {
    const normalized = token.toLowerCase()
    if (normalized === 'btc') return 8
    if (NATIVE_TOKEN_ADDRESSES.has(normalized)) return nativeDecimalsForChain(this.context.sourceChainId, this.context.nativeTokenDecimals)
    const configured = this.context.tokenDecimals[token] ?? this.context.tokenDecimals[normalized]
    if (configured != null) return configured
    const resolved = await this.context.lookupDecimals?.(token)
    if (resolved != null) return resolved
    throw new ButterActionRequiredError(
      `Token decimals are required for ${token}; Butter could not resolve them, configure tokenDecimals`
    )
  }

  private validateRouteMatchesRequest (route: ButterRoute, request: Record<string, unknown>): void {
    if (!route.hash) throw new ButterApiError('Butter route is missing hash', route)
    if (normalizeId(route.srcChain?.chainId) !== normalizeId(request.fromChainId as string | number)) {
      throw new ButterApiError('Butter route source chain does not match request', { route, request })
    }
    // For a cross-chain request, dstChain must be present and match the target.
    // A missing dstChain denotes a same-chain path in Butter's `/route` shape, so
    // accepting it for a cross-chain request would quote the wrong (source) leg.
    const crossChain = normalizeId(request.fromChainId as string | number) !== normalizeId(request.toChainId as string | number)
    if (crossChain && !route.dstChain) {
      throw new ButterApiError('Butter cross-chain route is missing dstChain', { route, request })
    }
    if (route.dstChain && normalizeId(route.dstChain.chainId) !== normalizeId(request.toChainId as string | number)) {
      throw new ButterApiError('Butter route destination chain does not match request', { route, request })
    }
    if (route.srcChain?.tokenIn?.address && !sameToken(route.srcChain.tokenIn.address, String(request.tokenInAddress))) {
      throw new ButterApiError('Butter route source token does not match request', { route, request })
    }
    const outputToken = route.dstChain?.tokenOut ?? route.srcChain?.tokenOut
    if (outputToken?.address && !sameToken(outputToken.address, String(request.tokenOutAddress))) {
      throw new ButterApiError('Butter route destination token does not match request', { route, request })
    }
  }
}

export function routeExpiresAt (route: ButterRoute, now: number): number {
  if (route.timestamp != null) {
    const timestamp = Number(route.timestamp)
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new ButterApiError('Butter route has an invalid timestamp', route)
    }
    const seconds = timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp
    return Math.min(seconds + ROUTE_TTL_SECONDS, now + ROUTE_TTL_SECONDS)
  }
  return now + ROUTE_TTL_SECONDS
}

/**
 * Reads a route token's decimals, requiring them to be present and valid.
 *
 * Butter always echoes token decimals on a route; a missing value indicates
 * malformed data, so we fail rather than silently defaulting to 18 (which
 * would misscale amounts by orders of magnitude).
 */
export function decimalsOf (token: { decimals?: string | number } | undefined, label = 'token'): number {
  const decimals = Number(token?.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Butter route is missing valid ${label} decimals`, token)
  }
  return decimals
}

function stableRouteKey (request: Record<string, unknown>, options: SwidgeOptions): string {
  return JSON.stringify({
    ...request,
    fromTokenAmount: 'fromTokenAmount' in options && options.fromTokenAmount != null ? String(options.fromTokenAmount) : undefined,
    toTokenAmount: 'toTokenAmount' in options && options.toTokenAmount != null ? String(options.toTokenAmount) : undefined
  })
}

function normalizeId (id: string | number | undefined): string {
  return id == null ? '' : String(id)
}

function sameToken (a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
