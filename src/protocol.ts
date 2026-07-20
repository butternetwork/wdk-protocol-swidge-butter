import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'
import {
  DEFAULT_APP_BASE_URL,
  DEFAULT_ROUTER_BASE_URL,
  DEFAULT_TOKEN_BASE_URL,
  NATIVE_TOKEN_ADDRESSES,
  TRON_CHAIN_ID
} from './constants.js'
import { ButterHttpClient } from './http.js'
import { RouteManager } from './route.js'
import { routeToQuote } from './mappers.js'
import { DiscoveryService } from './discovery.js'
import { validateSwapTransactions, type SwapValidationContext } from './swap-data.js'
import { executeEvmSwap, isNativeToken } from './evm.js'
import { mapStatusResponse } from './status.js'
import {
  createRouterRegistry,
  routerDeploymentsForChain,
  type ButterRouterRegistry
} from './router-registry.js'
import {
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterUnsupportedError
} from './errors.js'
import type {
  ButterAccount,
  ButterRoute,
  ButterSwidgeProtocolConfig,
  ButterSwapTx,
  SwidgeOptions,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions
} from './types.js'

export class ButterSwidgeProtocol extends SwidgeProtocol {
  private readonly account: ButterAccount | undefined
  private readonly config: ButterSwidgeProtocolConfig
  private readonly http: ButterHttpClient
  private readonly routes: RouteManager
  private readonly discovery: DiscoveryService
  private readonly now: () => number
  private readonly sourceChainId: string
  private readonly routerRegistry: ButterRouterRegistry

  constructor (account: ButterAccount | undefined, config: ButterSwidgeProtocolConfig) {
    super(account as never, config)
    if (config.sourceChainId == null || config.sourceChainId === '') {
      throw new ButterConfigurationError('sourceChainId is required')
    }
    if (!config.entrance) {
      throw new ButterConfigurationError('entrance is required')
    }
    this.account = account
    this.config = config
    this.sourceChainId = String(config.sourceChainId)
    this.routerRegistry = createRouterRegistry(config.routerContracts)
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000))
    const fetchImpl = config.fetch ?? (globalThis.fetch as unknown as ButterSwidgeProtocolConfig['fetch'])
    if (!fetchImpl) {
      throw new ButterConfigurationError('A fetch implementation is required')
    }
    this.http = new ButterHttpClient({
      routerBaseUrl: config.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL,
      tokenBaseUrl: config.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL,
      appBaseUrl: config.appBaseUrl ?? DEFAULT_APP_BASE_URL,
      fetch: fetchImpl,
      apiKeyId: config.apiKeyId,
      apiSecret: config.apiSecret,
      authMode: config.authMode ?? 'required'
    })
    this.routes = new RouteManager({
      sourceChainId: this.sourceChainId,
      entrance: config.entrance,
      now: this.now,
      tokenDecimals: config.tokenDecimals ?? {},
      requestRoute: (params) => this.http.router<ButterRoute[] | ButterRoute>('/route', params)
    })
    this.discovery = new DiscoveryService(
      config,
      (path, params) => this.http.router(path, params),
      (path, params) => this.http.token(path, params)
    )
  }

  async quoteSwidge (options: SwidgeOptions): Promise<SwidgeQuote> {
    this.assertQuoteOptions(options)
    this.assertExecutionSupportForQuote()
    const cached = await this.routes.getRoute(options)
    this.routes.enforceMinAmountOut(options, cached.route)
    return routeToQuote(cached.route, this.now, cached.expiresAt)
  }

  async swidge (options: SwidgeOptions): Promise<SwidgeResult> {
    this.assertQuoteOptions(options)
    const sender = await this.getSender()
    const receiver = options.recipient ?? sender
    const cached = await this.routes.getRoute(options, { forExecution: true })
    this.routes.enforceMinAmountOut(options, cached.route)
    const quote = routeToQuote(cached.route, this.now, cached.expiresAt)
    const swapData = await this.http.router<ButterSwapTx[]>('/swap', {
      hash: cached.route.hash,
      slippage: cached.slippageBps,
      from: sender,
      receiver
    })
    const nativeSource = isNativeToken(options.fromToken)
    const swapValidationContext: SwapValidationContext = {
      sourceChainId: this.sourceChainId,
      destinationChainId: String(options.toChain ?? this.sourceChainId),
      route: cached.route,
      routerRegistry: this.routerRegistry,
      nativeSource,
      minimumAmountOut: quote.toTokenAmountMin,
      sender,
      receiver,
      sourceToken: options.fromToken,
      destinationToken: options.toToken,
      requireRouterAllowlist: this.isBuiltInEvmExecution()
    }
    if ('fromTokenAmount' in options && options.fromTokenAmount != null) {
      swapValidationContext.requestedAmountIn = BigInt(options.fromTokenAmount)
    }
    const swapTransactions = validateSwapTransactions(swapData, swapValidationContext)
    const transactions = []
    for (const swapTx of swapTransactions) {
      if (this.isBuiltInEvmExecution()) {
        transactions.push(...await executeEvmSwap({
          account: this.account,
          config: this.config,
          sender,
          route: cached.route,
          swapTx,
          options,
          sourceChainId: this.sourceChainId,
          nativeSource
        }))
      } else {
        const adapter = this.config.transactionAdapters?.[this.sourceChainId]
        if (!adapter) throw new ButterUnsupportedError(`No transaction adapter configured for chain ${this.sourceChainId}`)
        if (!this.account?.sendTransaction) throw new ButterUnsupportedError('An account with sendTransaction is required for adapter execution')
        const result = await this.account.sendTransaction(adapter(swapTx, { sender, receiver, route: cached.route, options }))
        transactions.push({ hash: hashOf(result), chain: this.sourceChainId, type: 'source' as const })
      }
    }
    const sourceTx = transactions.find((tx) => tx.type === 'source')
    return {
      id: sourceTx?.hash ?? cached.route.hash,
      hash: sourceTx?.hash,
      fees: quote.fees,
      transactions,
      fromTokenAmount: quote.fromTokenAmount,
      toTokenAmount: quote.toTokenAmount,
      toTokenAmountMin: quote.toTokenAmountMin
    }
  }

  async getSwidgeStatus (id: string, options: { byOrderId?: boolean, fromChain?: string | number, toChain?: string | number } = {}): Promise<SwidgeStatusResult> {
    const data = options.byOrderId
      ? await this.http.app('/api/queryCrossInfoByOrderId', { orderId: id })
      : await this.http.app('/api/queryBridgeInfoBySourceHash', { hash: id })
    return mapStatusResponse(id, data, options)
  }

  async getSupportedChains (): Promise<SwidgeSupportedChain[]> {
    return this.discovery.getSupportedChains()
  }

  async getSupportedTokens (options: SwidgeSupportedTokensOptions = {}): Promise<SwidgeSupportedToken[]> {
    const chainId = String(options.fromChain ?? options.toChain ?? this.sourceChainId)
    return this.discovery.getSupportedTokens(chainId)
  }

  private assertQuoteOptions (options: SwidgeOptions): void {
    if (options.refundAddress) {
      throw new ButterUnsupportedError('Butter router does not expose an explicit refundAddress parameter')
    }
    if (!options.fromToken || !options.toToken) {
      throw new ButterUnsupportedError('fromToken and toToken are required')
    }
    const hasInput = 'fromTokenAmount' in options && options.fromTokenAmount != null
    const hasOutput = 'toTokenAmount' in options && options.toTokenAmount != null
    if (hasOutput) throw new ButterExactOutUnsupportedError()
    if (hasInput === hasOutput) {
      throw new ButterUnsupportedError('fromTokenAmount is required')
    }
    const inputAmount = options.fromTokenAmount
    if (typeof inputAmount === 'number' && !Number.isSafeInteger(inputAmount)) {
      throw new ButterUnsupportedError('fromTokenAmount must use bigint base units when it exceeds safe integer precision')
    }
    try {
      if (BigInt(inputAmount as bigint) <= 0n) {
        throw new ButterUnsupportedError('fromTokenAmount must be greater than zero')
      }
    } catch (cause) {
      if (cause instanceof ButterUnsupportedError) throw cause
      throw new ButterUnsupportedError('fromTokenAmount must be a positive integer in base units', { cause })
    }
  }

  private assertExecutionSupportForQuote (): void {
    if (this.config.exposeQuoteOnlyChains) return
    if (this.isBuiltInEvmExecution()) return
    if (this.config.transactionAdapters?.[this.sourceChainId]) return
    throw new ButterUnsupportedError(`Chain ${this.sourceChainId} is not executable without a transaction adapter`)
  }

  private isBuiltInEvmExecution (): boolean {
    return this.sourceChainId !== TRON_CHAIN_ID && routerDeploymentsForChain(this.routerRegistry, this.sourceChainId).length > 0
  }

  private async getSender (): Promise<string> {
    if (this.config.evm?.walletClient?.account?.address) return this.config.evm.walletClient.account.address
    if (this.account?.getAddress) return this.account.getAddress()
    if (this.account?.address) return this.account.address
    throw new ButterUnsupportedError('A sender address is required')
  }
}

function hashOf (result: string | { hash?: string }): string {
  if (typeof result === 'string') return result
  if (result.hash) return result.hash
  throw new ButterConfigurationError('Transaction sender did not return a hash')
}

export default ButterSwidgeProtocol
