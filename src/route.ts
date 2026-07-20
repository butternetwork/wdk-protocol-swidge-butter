import {
  NATIVE_TOKEN_ADDRESSES,
  ROUTE_EXPIRY_MARGIN_SECONDS,
  ROUTE_TTL_SECONDS,
  SOLANA_CHAIN_ID
} from './constants.js'
import {
  ButterActionRequiredError,
  ButterApiError,
  ButterQuoteExpiredError,
  ButterQuoteRequiredError
} from './errors.js'
import { formatTokenAmount, parseTokenAmount } from './amounts.js'
import { toButterSlippage } from './slippage.js'
import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js'

export interface RouteRequestContext {
  sourceChainId: string
  entrance: string
  now: () => number
  tokenDecimals: Record<string, number>
  requestRoute: (params: Record<string, unknown>) => Promise<ButterRoute[] | ButterRoute>
}

export class RouteManager {
  private readonly context: RouteRequestContext
  private readonly cache = new Map<string, CachedRoute>()

  constructor (context: RouteRequestContext) {
    this.context = context
  }

  async getRoute (options: SwidgeOptions, { forExecution = false }: { forExecution?: boolean } = {}): Promise<CachedRoute> {
    const request = this.buildRouteRequest(options)
    const key = stableRouteKey(request, options)
    const cached = this.cache.get(key)
    if (forExecution) {
      if (!cached) throw new ButterQuoteRequiredError()
      this.cache.delete(key)
      if (cached.expiresAt <= this.context.now()) throw new ButterQuoteExpiredError()
      return cached
    }
    if (cached && cached.expiresAt - ROUTE_EXPIRY_MARGIN_SECONDS > this.context.now()) {
      return cached
    }

    const response = await this.context.requestRoute(request)
    const route = Array.isArray(response) ? response[0] : response
    if (!route || route.hasLiquidity === false) {
      throw new ButterApiError('Butter router returned no liquid route', response)
    }
    this.validateRouteMatchesRequest(route, request)
    const cachedRoute = {
      key,
      route,
      slippageBps: Number(request.slippage),
      expiresAt: routeExpiresAt(route, this.context.now())
    }
    this.cache.set(key, cachedRoute)
    return cachedRoute
  }

  buildRouteRequest (options: SwidgeOptions): Record<string, unknown> {
    const toChainId = normalizeId(options.toChain ?? this.context.sourceChainId)
    if (this.context.sourceChainId === SOLANA_CHAIN_ID && !options.recipient) {
      throw new ButterActionRequiredError('Butter requires receiver when source chain is Solana')
    }
    const exactIn = 'fromTokenAmount' in options && options.fromTokenAmount != null
    const amount = exactIn
      ? formatTokenAmount(options.fromTokenAmount, this.decimalsFor(options.fromToken))
      : formatTokenAmount(options.toTokenAmount, this.decimalsFor(options.toToken))
    const slippage = toButterSlippage(options.slippage, {
      crossChain: toChainId !== this.context.sourceChainId,
      sourceChainId: this.context.sourceChainId,
      toChainId
    })

    return {
      fromChainId: this.context.sourceChainId,
      toChainId,
      amount,
      tokenInAddress: options.fromToken,
      tokenOutAddress: options.toToken,
      type: exactIn ? 'exactIn' : 'exactOut',
      slippage,
      receiver: options.recipient,
      entrance: this.context.entrance
    }
  }

  enforceMinAmountOut (options: SwidgeOptions, route: ButterRoute): void {
    if (options.minAmountOut == null) return
    const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut)
    const routeMinimum = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals)
    if (routeMinimum < BigInt(options.minAmountOut)) {
      throw new ButterActionRequiredError('Butter route minimum output is below requested minAmountOut', {
        requestedMinAmountOut: String(options.minAmountOut),
        routeMinimum: String(routeMinimum)
      })
    }
  }

  private decimalsFor (token: string): number {
    const normalized = token.toLowerCase()
    if (normalized === 'btc') return 8
    if (NATIVE_TOKEN_ADDRESSES.has(normalized)) return 18
    const decimals = this.context.tokenDecimals[token] ?? this.context.tokenDecimals[normalized]
    if (decimals == null) {
      throw new ButterActionRequiredError(`Token decimals are required for ${token}`)
    }
    return decimals
  }

  private validateRouteMatchesRequest (route: ButterRoute, request: Record<string, unknown>): void {
    if (!route.hash) throw new ButterApiError('Butter route is missing hash', route)
    if (normalizeId(route.srcChain?.chainId) !== normalizeId(request.fromChainId as string | number)) {
      throw new ButterApiError('Butter route source chain does not match request', { route, request })
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

export function decimalsOf (token: { decimals?: string | number } | undefined): number {
  return Number(token?.decimals ?? 18)
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
