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

import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'
import {
  DEFAULT_APP_BASE_URL,
  DEFAULT_ROUTER_BASE_URL,
  DEFAULT_TOKEN_BASE_URL,
  OPERATION_KIND_MAX_ENTRIES,
  SOLANA_CHAIN_ID,
  TRON_CHAIN_ID
} from './constants.js'
import { ButterHttpClient } from './http.js'
import { RouteManager } from './route.js'
import {
  enforceFeeLimits,
  resolveFeeLimits,
  routeNativeFee,
  validateFeeLimits,
  type FeeContext
} from './fees.js'
import { routeToQuote } from './mappers.js'
import { DiscoveryService } from './discovery.js'
import { routerFunctionName, validateSwapTransactions, type SwapValidationContext } from './swap-data.js'
import { executeEvmSwap, isNativeToken } from './evm.js'
import { mapReceiptStatus, mapStatusResponse } from './status.js'
import {
  createRouterRegistry,
  routerDeploymentsForChain,
  type ButterRouterRegistry
} from './router-registry.js'
import {
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterReadOnlyAccountError,
  ButterUnsupportedError
} from './errors.js'
import type {
  ButterAccount,
  ButterRoute,
  ButterSupportedChain,
  ButterSwidgeOptions,
  ButterSwidgeProtocolConfig,
  ButterSwidgeQuote,
  ButterSwapTx,
  CachedRoute,
  EvmTransactionReceipt,
  SwidgeFee,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction
} from './types.js'

/** Butter Smart Router implementation of the WDK Swidge protocol. */
export class ButterSwidgeProtocol extends SwidgeProtocol {
  private readonly account: ButterAccount | undefined
  private readonly config: ButterSwidgeProtocolConfig
  private readonly http: ButterHttpClient
  private readonly routes: RouteManager
  private readonly discovery: DiscoveryService
  private readonly now: () => number
  private readonly sourceChainId: string
  private readonly routerRegistry: ButterRouterRegistry
  private readonly feeContext: FeeContext
  private readonly maxNativeFee: bigint | undefined
  // Remembers whether an executed operation was same- or cross-chain, keyed by
  // source hash, so getSwidgeStatus can route correctly when the caller omits
  // the optional fromChain/toChain hints. Instance-scoped (like the route cache).
  private readonly operationKinds = new Map<string, { fromChain: string, toChain: string }>()

  /** Creates a protocol instance bound to one source chain. */
  constructor (account: ButterAccount | undefined, config: ButterSwidgeProtocolConfig) {
    // Validate configuration before any base-class behavior can surface less
    // specific errors (statements before super() may not reference `this`).
    if (config.sourceChainId == null || config.sourceChainId === '') {
      throw new ButterConfigurationError('sourceChainId is required')
    }
    if (!config.entrance) {
      throw new ButterConfigurationError('entrance is required')
    }
    validateFeeLimits(config)
    const maxNativeFee = parseMaxNativeFee(config.maxNativeFee)
    const fetchImpl = config.fetch ?? (globalThis.fetch as unknown as ButterSwidgeProtocolConfig['fetch'])
    if (!fetchImpl) {
      throw new ButterConfigurationError('A fetch implementation is required')
    }
    // ButterAccount is a structural subset of the WDK account interfaces; the
    // base class only stores the reference, so the widening cast is safe.
    super(account as ConstructorParameters<typeof SwidgeProtocol>[0], config)
    this.account = account
    this.config = config
    this.maxNativeFee = maxNativeFee
    this.sourceChainId = String(config.sourceChainId)
    this.routerRegistry = createRouterRegistry(config.routerContracts)
    this.feeContext = {
      sourceChainId: this.sourceChainId,
      sourceToken: '',
      ...(config.nativeTokenDecimals ? { nativeTokenDecimals: config.nativeTokenDecimals } : {})
    }
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000))
    this.http = new ButterHttpClient({
      routerBaseUrl: config.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL,
      tokenBaseUrl: config.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL,
      appBaseUrl: config.appBaseUrl ?? DEFAULT_APP_BASE_URL,
      fetch: fetchImpl,
      apiKeyId: config.apiKeyId,
      apiSecret: config.apiSecret,
      authMode: config.authMode ?? 'optional'
    })
    const strictSlippageChainIds = new Set((config.strictSlippageChainIds ?? []).map(String))
    this.discovery = new DiscoveryService(
      config,
      (path, params) => this.http.router(path, params),
      (path, params) => this.http.token(path, params),
      strictSlippageChainIds,
      this.routerRegistry
    )
    this.routes = new RouteManager({
      sourceChainId: this.sourceChainId,
      entrance: config.entrance,
      now: this.now,
      tokenDecimals: config.tokenDecimals ?? {},
      nativeTokenDecimals: config.nativeTokenDecimals ?? {},
      strictSlippageChainIds,
      requestRoute: (params) => this.http.router<ButterRoute[] | ButterRoute>('/route', params),
      lookupDecimals: (token) => this.discovery.findTokenDecimals(this.sourceChainId, token)
    })
  }

  /**
   * Returns a non-binding exact-in quote without requiring execution capability.
   *
   * Fee caps are intentionally not enforced here: a quote must remain a fully
   * inspectable estimate (WDK only mandates rejection in {@link swidge}). Fee
   * limits are applied at execution time.
   *
   * The returned quote carries `routeHash`; pass it back as `options.routeHash`
   * to {@link swidge} to pin this exact route instead of auto-re-quoting.
   */
  async quoteSwidge (options: SwidgeOptions): Promise<ButterSwidgeQuote> {
    this.assertQuoteOptions(options)
    // The sender fallback is only used to default the receiver for a Solana
    // source; avoid an unnecessary getAddress() call for every other chain.
    const senderFallback = this.sourceChainId === SOLANA_CHAIN_ID ? await this.resolveSenderOrUndefined() : undefined
    const cached = await this.routes.getRoute(options, { senderFallback })
    this.routes.enforceMinAmountOut(options, cached.route)
    const quote = routeToQuote(cached.route, this.now, cached.expiresAt, this.feeContextFor(options.fromToken), options.fromTokenAmount)
    return { ...quote, routeHash: cached.route.hash }
  }

  /** Executes an exact-in operation after validating route fees and transaction intent. */
  async swidge (options: ButterSwidgeOptions, config: SwidgeProtocolConfig = {}): Promise<SwidgeResult> {
    this.assertQuoteOptions(options)
    this.assertExecutionCapability()
    const sender = await this.getSender()
    if (options.refundAddress && !sameRecipient(options.refundAddress, sender)) {
      throw new ButterUnsupportedError('Butter requires refundAddress to match the source sender')
    }
    const receiver = options.recipient ?? sender
    const pinnedHash = normalizeRouteHash(options.routeHash)
    const cached: CachedRoute = pinnedHash != null
      ? await this.routes.consumeRouteByHash(pinnedHash, options, sender)
      : await this.routes.getRoute(options, { forExecution: true, senderFallback: sender })
    this.routes.enforceMinAmountOut(options, cached.route)
    // assertQuoteOptions guarantees a valid, positive exact-in amount.
    const requestedAmountIn = BigInt(options.fromTokenAmount as number | bigint)
    const feeContext: FeeContext = { ...this.feeContextFor(options.fromToken), requestedAmountIn }
    enforceFeeLimits(cached.route, feeContext, resolveFeeLimits(this.config, config))
    const quote = routeToQuote(cached.route, this.now, cached.expiresAt, feeContext, options.fromTokenAmount)
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
      requireRouterAllowlist: this.isBuiltInEvmExecution(),
      routerNativeFee: routeNativeFee(cached.route, feeContext),
      requestedAmountIn,
      ...(this.maxNativeFee != null ? { maxNativeFee: this.maxNativeFee } : {}),
      ...(cached.route.feeConfig ? { feeConfig: cached.route.feeConfig } : {})
    }
    const swapTransactions = validateSwapTransactions(swapData, swapValidationContext)
    const transactions: SwidgeTransaction[] = []
    // One entry per execution unit; undefined means that unit's gas was not
    // measured. Only fold in a measured fee when EVERY unit reported one.
    const feeParts: Array<bigint | undefined> = []
    if (this.isBuiltInEvmExecution()) {
      // The built-in EVM path is exactly one Router transaction (enforced by
      // validateSwapTransactions); executeEvmSwap adds any approval + the source.
      for (const swapTx of swapTransactions) {
        const executed = await executeEvmSwap({
          account: this.account,
          config: this.config,
          sender,
          route: cached.route,
          swapTx,
          options,
          sourceChainId: this.sourceChainId,
          nativeSource
        })
        transactions.push(...executed.transactions)
        feeParts.push(executed.gasFee)
      }
    } else {
      const adapter = this.config.transactionAdapters?.[this.sourceChainId]
      if (!adapter) throw new ButterUnsupportedError(`No transaction adapter configured for chain ${this.sourceChainId}`)
      if (!this.account?.sendTransaction) throw new ButterUnsupportedError('An account with sendTransaction is required for adapter execution')
      const sendTransaction = this.account.sendTransaction.bind(this.account)
      // Normalize and CLASSIFY every adapter output BEFORE broadcasting any of
      // them. A partial broadcast that then fails classification would leave
      // already-sent transactions a retry could double-execute, so all validation
      // (legal types, exactly one `source`) must complete before the first send.
      const adapted = swapTransactions.map((swapTx) =>
        normalizeAdapterResult(adapter(swapTx, { sender, receiver, route: cached.route, options })))
      const classified = resolveAdapterTypes(adapted)
      for (const entry of classified) {
        const result = await sendTransaction(entry.transaction)
        transactions.push({ hash: hashOf(result), chain: this.sourceChainId, type: entry.type })
        feeParts.push(feeOf(result))
      }
    }
    const sourceTx = transactions.find((tx) => tx.type === 'source')
    if (!sourceTx) {
      // Every validated swap transaction produces a source entry; reaching
      // this indicates a bug rather than a recoverable condition.
      throw new ButterApiError('Butter execution produced no source transaction', { transactions })
    }
    this.rememberOperationKind(sourceTx.hash, String(options.toChain ?? this.sourceChainId))
    const actualNetworkFee = feeParts.length > 0 && feeParts.every((fee) => fee != null)
      ? feeParts.reduce((total, fee) => total + (fee as bigint), 0n)
      : undefined
    return {
      id: sourceTx.hash,
      hash: sourceTx.hash,
      fees: actualNetworkFee != null ? withMeasuredNetworkFee(quote.fees, actualNetworkFee, cached.route) : quote.fees,
      transactions,
      fromTokenAmount: quote.fromTokenAmount,
      toTokenAmount: quote.toTokenAmount,
      toTokenAmountMin: quote.toTokenAmountMin
    }
  }

  /**
   * Retrieves a Butter operation by source hash or, when requested, order ID.
   *
   * Same-chain swaps produce no Butter cross-chain record, so when the caller
   * indicates a same-chain operation (`fromChain === toChain`) the status is
   * derived from the transaction receipt instead of the cross-chain APIs.
   */
  async getSwidgeStatus (id: string, options: { byOrderId?: boolean, fromChain?: string | number, toChain?: string | number } = {}): Promise<SwidgeStatusResult> {
    if (!id.trim()) throw new ButterApiError('A non-empty swidge id is required')
    if (!options.byOrderId) {
      const recorded = this.operationKinds.get(id.toLowerCase())
      if (recorded != null) {
        // Recorded by this instance → trusted attribution; no re-verification.
        if (recorded.fromChain === recorded.toChain) return this.getSameChainStatus(id, recorded.fromChain)
      } else {
        // Not recorded: only treat as same-chain after verifying the source tx
        // actually belongs to a Butter Router (allowlisted target + swapAndCall).
        // Explicit hints do NOT bypass this — an unrelated tx must never be
        // reported as a completed swidge (WDK: an unknown id should throw).
        const attribution = await this.attributeSourceTransaction(id)
        if (attribution === 'same') return this.getSameChainStatus(id, this.sourceChainId)
        const hintedSameChain = options.fromChain != null && options.toChain != null &&
          String(options.fromChain) === String(options.toChain)
        if (attribution == null && hintedSameChain) {
          throw new ButterApiError(
            'Cannot verify a same-chain Butter swidge: source transaction is not an allowlisted Router swapAndCall on this chain (configure evm.publicClient.getTransaction)',
            { id }
          )
        }
        // attribution 'cross', or unresolved without same-chain hints → cross API.
      }
    }
    const data = options.byOrderId
      ? await this.http.app('/api/queryCrossInfoByOrderId', { orderId: id })
      : await this.http.app('/api/queryBridgeInfoBySourceHash', { hash: id })
    return mapStatusResponse(id, data, options)
  }

  /** Records an executed operation's chain kind for later status routing, bounding memory. */
  private rememberOperationKind (sourceHash: string, toChain: string): void {
    const key = sourceHash.toLowerCase()
    this.operationKinds.delete(key)
    this.operationKinds.set(key, { fromChain: this.sourceChainId, toChain })
    while (this.operationKinds.size > OPERATION_KIND_MAX_ENTRIES) {
      const oldest = this.operationKinds.keys().next().value
      if (oldest === undefined) break
      this.operationKinds.delete(oldest)
    }
  }

  /**
   * Attributes a source transaction to a Butter Router by fetching its calldata
   * (`evm.publicClient.getTransaction`) and requiring BOTH an allowlisted Router
   * target AND a recognized Router function: `swapAndCall` → same-chain,
   * `swapAndBridge` → cross-chain. Returns undefined when it cannot attribute (no
   * `getTransaction`, the transaction is not found, a non-allowlisted target, or an
   * unrecognized function), so an unrelated transaction is never taken for a Butter
   * swidge. Infrastructure errors from `getTransaction` (RPC timeout, auth,
   * rate-limit) propagate rather than being swallowed as "unattributable", so a
   * genuine node fault surfaces to the caller instead of forcing a silent cross-API
   * fallback. Stateless: works across process restarts and new instances.
   */
  private async attributeSourceTransaction (hash: string): Promise<'same' | 'cross' | undefined> {
    const getTransaction = this.config.evm?.publicClient?.getTransaction
    if (!getTransaction) return undefined
    // A not-found transaction resolves to null (unattributable); infrastructure
    // errors intentionally propagate.
    const tx = await getTransaction(hash)
    if (!tx?.to || !this.isAllowlistedRouter(tx.to)) return undefined
    const fn = routerFunctionName(tx.input)
    if (fn === 'swapAndCall') return 'same'
    if (fn === 'swapAndBridge') return 'cross'
    return undefined
  }

  /** True when the address is an allowlisted Router deployment on the source chain. */
  private isAllowlistedRouter (address: string): boolean {
    const normalized = address.toLowerCase()
    return routerDeploymentsForChain(this.routerRegistry, this.sourceChainId)
      .some((deployment) => deployment.address.toLowerCase() === normalized)
  }

  private async getSameChainStatus (id: string, chain: string | number): Promise<SwidgeStatusResult> {
    const getReceipt = this.config.evm?.publicClient?.getTransactionReceipt?.bind(this.config.evm.publicClient) ??
      this.account?.getTransactionReceipt?.bind(this.account)
    if (!getReceipt) {
      throw new ButterConfigurationError('Same-chain swidge status requires evm.publicClient or an account with getTransactionReceipt')
    }
    const receipt = await getReceipt(id) as EvmTransactionReceipt | null
    return mapReceiptStatus(id, receipt, chain)
  }

  /**
   * Lists chains currently advertised by Butter Router.
   *
   * Each entry carries an `execution` field (`native` | `adapter` |
   * `quote-only`) describing how this instance would execute on that chain.
   */
  async getSupportedChains (): Promise<ButterSupportedChain[]> {
    return this.discovery.getSupportedChains()
  }

  /**
   * Lists all Butter-supported tokens for the selected chain.
   *
   * Chain selection uses `fromChain`, then `toChain`, then the instance's
   * source chain. Route-scoped `fromToken` filtering is not implemented:
   * Butter's token API only supports per-chain listing.
   */
  async getSupportedTokens (options: SwidgeSupportedTokensOptions = {}): Promise<SwidgeSupportedToken[]> {
    const chainId = String(options.fromChain ?? options.toChain ?? this.sourceChainId)
    return this.discovery.getSupportedTokens(chainId)
  }

  private assertQuoteOptions (options: SwidgeOptions): void {
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

  private isBuiltInEvmExecution (): boolean {
    return this.sourceChainId !== TRON_CHAIN_ID && routerDeploymentsForChain(this.routerRegistry, this.sourceChainId).length > 0
  }

  private async getSender (): Promise<string> {
    const accountAddress = this.account?.getAddress ? await this.account.getAddress() : undefined
    const walletAddress = this.config.evm?.walletClient?.account?.address
    // Guard against a signer/initiator split: if both an account and a wallet
    // client are configured with different addresses, the on-chain signer and
    // the calldata initiator would diverge and Butter Router would reject.
    if (accountAddress && walletAddress && !sameRecipient(accountAddress, walletAddress)) {
      throw new ButterConfigurationError('Account address and evm.walletClient account address differ; configure a single sender', {
        accountAddress,
        walletAddress
      })
    }
    const sender = accountAddress ?? walletAddress
    if (!sender) {
      throw new ButterReadOnlyAccountError('Swidge execution requires a sender address from an account or evm.walletClient')
    }
    return sender
  }

  /** Resolves a sender address without throwing (used to default Solana recipient at quote time). */
  private async resolveSenderOrUndefined (): Promise<string | undefined> {
    if (this.account?.getAddress) return this.account.getAddress()
    return this.config.evm?.walletClient?.account?.address
  }

  private assertExecutionCapability (): void {
    if (this.isBuiltInEvmExecution()) {
      // WDK contract: swidge() requires a full (send-capable) account — reject
      // undefined or read-only accounts up front, matching the interface's
      // documented behavior.
      if (!this.account?.sendTransaction) throw new ButterReadOnlyAccountError()
      // A full account still cannot carry the swap/approval calldata: the WDK
      // `Transaction` type is only `{ to, value }`, so `data`/`chainId` would be
      // dropped. An EVM-capable sender (`evm.walletClient`) is additionally
      // required; the account is used only for address resolution and receipt
      // polling. (This can merge once WDK extends `Transaction` with `data`.)
      if (!this.config.evm?.walletClient) {
        throw new ButterReadOnlyAccountError(
          'Butter EVM Router execution requires evm.walletClient to carry the swap calldata; the WDK account cannot (its Transaction type is only { to, value })'
        )
      }
      return
    }
    if (!this.config.transactionAdapters?.[this.sourceChainId]) {
      throw new ButterConfigurationError(`No transaction adapter configured for chain ${this.sourceChainId}`)
    }
    if (!this.account?.sendTransaction) throw new ButterReadOnlyAccountError()
  }

  private feeContextFor (sourceToken: string): FeeContext {
    return { ...this.feeContext, sourceToken }
  }
}

function hashOf (result: string | { hash?: string }): string {
  if (typeof result === 'string') return result
  if (result.hash) return result.hash
  throw new ButterConfigurationError('Transaction sender did not return a hash')
}

/**
 * Normalizes a transaction adapter's return into `{ transaction, type }`. An
 * object carrying a `transaction` property is the explicit form; anything else
 * is treated as a bare transaction with an unknown role.
 */
function normalizeAdapterResult (value: unknown): { transaction: unknown, type: SwidgeTransaction['type'] | undefined } {
  if (value != null && typeof value === 'object' && 'transaction' in value) {
    const wrapped = value as { transaction: unknown, type?: SwidgeTransaction['type'] }
    return { transaction: wrapped.transaction, type: wrapped.type }
  }
  return { transaction: value, type: undefined }
}

/** Legal `SwidgeTransaction` roles an adapter may declare. */
const ADAPTER_TYPES: ReadonlySet<string> = new Set(['source', 'destination', 'approval', 'refund', 'other'])

function isAdapterType (value: unknown): value is SwidgeTransaction['type'] {
  return typeof value === 'string' && ADAPTER_TYPES.has(value)
}

/**
 * Validates and resolves the roles of an adapter's normalized outputs BEFORE any
 * are broadcast. Every explicit type must be a legal `SwidgeTransaction` role; a
 * multi-transaction result must classify each entry; and the set must contain
 * exactly one `source` (the operation id and status anchor). A single untyped
 * transaction defaults to `source`. Throws so nothing is sent on any violation.
 */
function resolveAdapterTypes (
  adapted: Array<{ transaction: unknown, type: SwidgeTransaction['type'] | undefined }>
): Array<{ transaction: unknown, type: SwidgeTransaction['type'] }> {
  for (const entry of adapted) {
    if (entry.type != null && !isAdapterType(entry.type)) {
      throw new ButterUnsupportedError(`Adapter returned an unknown transaction type: ${String(entry.type)}`)
    }
  }
  // A multi-transaction adapter must classify each transaction so the primary
  // `source` (used as the operation id and for status) is unambiguous.
  if (adapted.length > 1 && adapted.some((entry) => entry.type == null)) {
    throw new ButterUnsupportedError('Adapter returned multiple transactions without an explicit type; return { transaction, type } for each so the source transaction is identifiable')
  }
  const resolved = adapted.map((entry) => ({ transaction: entry.transaction, type: entry.type ?? ('source' as const) }))
  const sources = resolved.filter((entry) => entry.type === 'source').length
  if (sources !== 1) {
    throw new ButterUnsupportedError(`Adapter must produce exactly one source transaction, but produced ${sources}`)
  }
  return resolved
}

/** Extracts a gas fee reported by a transaction sender, rejecting negative values. */
function feeOf (result: string | { hash?: string, fee?: bigint }): bigint | undefined {
  if (typeof result === 'string') return undefined
  if (result.fee != null && result.fee < 0n) {
    throw new ButterApiError('Transaction sender reported a negative fee', { fee: result.fee.toString() })
  }
  return result.fee
}

/**
 * Replaces the estimated network fee with the measured source gas fee, so the
 * result reports what was actually charged. The other (bridge/protocol) fees
 * remain route-derived estimates. If the quote had no network entry, one is
 * appended when a native fee token can be identified.
 */
function withMeasuredNetworkFee (fees: SwidgeFee[], measured: bigint, route: ButterRoute): SwidgeFee[] {
  let replaced = false
  const next = fees.map((fee) => {
    if (!replaced && fee.type === 'network') {
      replaced = true
      return { ...fee, amount: measured, description: 'Measured source gas fee' }
    }
    return fee
  })
  if (!replaced) {
    const token = route.gasFee?.address ?? route.gasFee?.symbol
    if (token) {
      next.push({ type: 'network', amount: measured, token, included: false, description: 'Measured source gas fee' })
    }
  }
  return next
}

function sameRecipient (left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** Validates and normalizes the optional maxNativeFee cap to native base units. */
function parseMaxNativeFee (value: number | bigint | undefined): bigint | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterConfigurationError('maxNativeFee must be a non-negative integer in native base units')
  }
  const result = BigInt(value)
  if (result < 0n) throw new ButterConfigurationError('maxNativeFee must be a non-negative integer in native base units')
  return result
}

/** Normalizes the optional Butter `routeHash` pin, treating empty strings as absent. */
function normalizeRouteHash (hash: string | undefined): string | undefined {
  return typeof hash === 'string' && hash.length > 0 ? hash : undefined
}

export default ButterSwidgeProtocol
