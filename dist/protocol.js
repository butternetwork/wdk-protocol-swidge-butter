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
import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
import { DEFAULT_APP_BASE_URL, DEFAULT_ROUTER_BASE_URL, DEFAULT_TOKEN_BASE_URL, TRON_CHAIN_ID } from './constants.js';
import { ButterHttpClient } from './http.js';
import { RouteManager } from './route.js';
import { enforceFeeLimits, resolveFeeLimits, routeNativeFee, validateFeeLimits } from './fees.js';
import { routeToQuote } from './mappers.js';
import { DiscoveryService } from './discovery.js';
import { validateSwapTransactions } from './swap-data.js';
import { executeEvmSwap, isNativeToken } from './evm.js';
import { mapReceiptStatus, mapStatusResponse } from './status.js';
import { createRouterRegistry, routerDeploymentsForChain } from './router-registry.js';
import { ButterApiError, ButterConfigurationError, ButterExactOutUnsupportedError, ButterReadOnlyAccountError, ButterUnsupportedError } from './errors.js';
/** Butter Smart Router implementation of the WDK Swidge protocol. */
export class ButterSwidgeProtocol extends SwidgeProtocol {
    account;
    config;
    http;
    routes;
    discovery;
    now;
    sourceChainId;
    routerRegistry;
    feeContext;
    /** Creates a protocol instance bound to one source chain. */
    constructor(account, config) {
        // Validate configuration before any base-class behavior can surface less
        // specific errors (statements before super() may not reference `this`).
        if (config.sourceChainId == null || config.sourceChainId === '') {
            throw new ButterConfigurationError('sourceChainId is required');
        }
        if (!config.entrance) {
            throw new ButterConfigurationError('entrance is required');
        }
        validateFeeLimits(config);
        const fetchImpl = config.fetch ?? globalThis.fetch;
        if (!fetchImpl) {
            throw new ButterConfigurationError('A fetch implementation is required');
        }
        // ButterAccount is a structural subset of the WDK account interfaces; the
        // base class only stores the reference, so the widening cast is safe.
        super(account, config);
        this.account = account;
        this.config = config;
        this.sourceChainId = String(config.sourceChainId);
        this.routerRegistry = createRouterRegistry(config.routerContracts);
        this.feeContext = {
            sourceChainId: this.sourceChainId,
            sourceToken: '',
            ...(config.nativeTokenDecimals ? { nativeTokenDecimals: config.nativeTokenDecimals } : {})
        };
        this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
        this.http = new ButterHttpClient({
            routerBaseUrl: config.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL,
            tokenBaseUrl: config.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL,
            appBaseUrl: config.appBaseUrl ?? DEFAULT_APP_BASE_URL,
            fetch: fetchImpl,
            apiKeyId: config.apiKeyId,
            apiSecret: config.apiSecret,
            authMode: config.authMode ?? 'optional'
        });
        const strictSlippageChainIds = new Set((config.strictSlippageChainIds ?? []).map(String));
        this.discovery = new DiscoveryService(config, (path, params) => this.http.router(path, params), (path, params) => this.http.token(path, params), strictSlippageChainIds, this.routerRegistry);
        this.routes = new RouteManager({
            sourceChainId: this.sourceChainId,
            entrance: config.entrance,
            now: this.now,
            tokenDecimals: config.tokenDecimals ?? {},
            nativeTokenDecimals: config.nativeTokenDecimals ?? {},
            strictSlippageChainIds,
            requestRoute: (params) => this.http.router('/route', params),
            lookupDecimals: (token) => this.discovery.findTokenDecimals(this.sourceChainId, token)
        });
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
    async quoteSwidge(options) {
        this.assertQuoteOptions(options);
        const cached = await this.routes.getRoute(options, { senderFallback: await this.resolveSenderOrUndefined() });
        this.routes.enforceMinAmountOut(options, cached.route);
        const quote = routeToQuote(cached.route, this.now, cached.expiresAt, this.feeContextFor(options.fromToken), options.fromTokenAmount);
        return { ...quote, routeHash: cached.route.hash };
    }
    /** Executes an exact-in operation after validating route fees and transaction intent. */
    async swidge(options, config = {}) {
        this.assertQuoteOptions(options);
        this.assertExecutionCapability();
        const sender = await this.getSender();
        if (options.refundAddress && !sameRecipient(options.refundAddress, sender)) {
            throw new ButterUnsupportedError('Butter requires refundAddress to match the source sender');
        }
        const receiver = options.recipient ?? sender;
        const pinnedHash = normalizeRouteHash(options.routeHash);
        const cached = pinnedHash != null
            ? await this.routes.consumeRouteByHash(pinnedHash, options, sender)
            : await this.routes.getRoute(options, { forExecution: true, senderFallback: sender });
        this.routes.enforceMinAmountOut(options, cached.route);
        const feeContext = this.feeContextFor(options.fromToken);
        enforceFeeLimits(cached.route, feeContext, resolveFeeLimits(this.config, config));
        const quote = routeToQuote(cached.route, this.now, cached.expiresAt, feeContext, options.fromTokenAmount);
        const swapData = await this.http.router('/swap', {
            hash: cached.route.hash,
            slippage: cached.slippageBps,
            from: sender,
            receiver
        });
        const nativeSource = isNativeToken(options.fromToken);
        const swapValidationContext = {
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
            ...(cached.route.feeConfig ? { feeConfig: cached.route.feeConfig } : {})
        };
        if ('fromTokenAmount' in options && options.fromTokenAmount != null) {
            swapValidationContext.requestedAmountIn = BigInt(options.fromTokenAmount);
        }
        const swapTransactions = validateSwapTransactions(swapData, swapValidationContext);
        const transactions = [];
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
                }));
            }
            else {
                const adapter = this.config.transactionAdapters?.[this.sourceChainId];
                if (!adapter)
                    throw new ButterUnsupportedError(`No transaction adapter configured for chain ${this.sourceChainId}`);
                if (!this.account?.sendTransaction)
                    throw new ButterUnsupportedError('An account with sendTransaction is required for adapter execution');
                const result = await this.account.sendTransaction(adapter(swapTx, { sender, receiver, route: cached.route, options }));
                transactions.push({ hash: hashOf(result), chain: this.sourceChainId, type: 'source' });
            }
        }
        const sourceTx = transactions.find((tx) => tx.type === 'source');
        if (!sourceTx) {
            // Every validated swap transaction produces a source entry; reaching
            // this indicates a bug rather than a recoverable condition.
            throw new ButterApiError('Butter execution produced no source transaction', { transactions });
        }
        return {
            id: sourceTx.hash,
            hash: sourceTx.hash,
            fees: quote.fees,
            transactions,
            fromTokenAmount: quote.fromTokenAmount,
            toTokenAmount: quote.toTokenAmount,
            toTokenAmountMin: quote.toTokenAmountMin
        };
    }
    /**
     * Retrieves a Butter operation by source hash or, when requested, order ID.
     *
     * Same-chain swaps produce no Butter cross-chain record, so when the caller
     * indicates a same-chain operation (`fromChain === toChain`) the status is
     * derived from the transaction receipt instead of the cross-chain APIs.
     */
    async getSwidgeStatus(id, options = {}) {
        if (!id.trim())
            throw new ButterApiError('A non-empty swidge id is required');
        if (options.fromChain != null && options.toChain != null && String(options.fromChain) === String(options.toChain)) {
            return this.getSameChainStatus(id, options.fromChain);
        }
        const data = options.byOrderId
            ? await this.http.app('/api/queryCrossInfoByOrderId', { orderId: id })
            : await this.http.app('/api/queryBridgeInfoBySourceHash', { hash: id });
        return mapStatusResponse(id, data, options);
    }
    async getSameChainStatus(id, chain) {
        const getReceipt = this.config.evm?.publicClient?.getTransactionReceipt?.bind(this.config.evm.publicClient) ??
            this.account?.getTransactionReceipt?.bind(this.account);
        if (!getReceipt) {
            throw new ButterConfigurationError('Same-chain swidge status requires evm.publicClient or an account with getTransactionReceipt');
        }
        const receipt = await getReceipt(id);
        return mapReceiptStatus(id, receipt, chain);
    }
    /**
     * Lists chains currently advertised by Butter Router.
     *
     * Each entry carries an `execution` field (`native` | `adapter` |
     * `quote-only`) describing how this instance would execute on that chain.
     */
    async getSupportedChains() {
        return this.discovery.getSupportedChains();
    }
    /**
     * Lists all Butter-supported tokens for the selected chain.
     *
     * Chain selection uses `fromChain`, then `toChain`, then the instance's
     * source chain. Route-scoped `fromToken` filtering is not implemented:
     * Butter's token API only supports per-chain listing.
     */
    async getSupportedTokens(options = {}) {
        const chainId = String(options.fromChain ?? options.toChain ?? this.sourceChainId);
        return this.discovery.getSupportedTokens(chainId);
    }
    assertQuoteOptions(options) {
        if (!options.fromToken || !options.toToken) {
            throw new ButterUnsupportedError('fromToken and toToken are required');
        }
        const hasInput = 'fromTokenAmount' in options && options.fromTokenAmount != null;
        const hasOutput = 'toTokenAmount' in options && options.toTokenAmount != null;
        if (hasOutput)
            throw new ButterExactOutUnsupportedError();
        if (hasInput === hasOutput) {
            throw new ButterUnsupportedError('fromTokenAmount is required');
        }
        const inputAmount = options.fromTokenAmount;
        if (typeof inputAmount === 'number' && !Number.isSafeInteger(inputAmount)) {
            throw new ButterUnsupportedError('fromTokenAmount must use bigint base units when it exceeds safe integer precision');
        }
        try {
            if (BigInt(inputAmount) <= 0n) {
                throw new ButterUnsupportedError('fromTokenAmount must be greater than zero');
            }
        }
        catch (cause) {
            if (cause instanceof ButterUnsupportedError)
                throw cause;
            throw new ButterUnsupportedError('fromTokenAmount must be a positive integer in base units', { cause });
        }
    }
    isBuiltInEvmExecution() {
        return this.sourceChainId !== TRON_CHAIN_ID && routerDeploymentsForChain(this.routerRegistry, this.sourceChainId).length > 0;
    }
    async getSender() {
        const accountAddress = this.account?.getAddress ? await this.account.getAddress() : undefined;
        const walletAddress = this.config.evm?.walletClient?.account?.address;
        // Guard against a signer/initiator split: if both an account and a wallet
        // client are configured with different addresses, the on-chain signer and
        // the calldata initiator would diverge and Butter Router would reject.
        if (accountAddress && walletAddress && !sameRecipient(accountAddress, walletAddress)) {
            throw new ButterConfigurationError('Account address and evm.walletClient account address differ; configure a single sender', {
                accountAddress,
                walletAddress
            });
        }
        const sender = accountAddress ?? walletAddress;
        if (!sender) {
            throw new ButterReadOnlyAccountError('Swidge execution requires a sender address from an account or evm.walletClient');
        }
        return sender;
    }
    /** Returns true when a sender address can be derived from the configuration. */
    hasSenderAddress() {
        return Boolean(this.account?.getAddress || this.config.evm?.walletClient?.account?.address);
    }
    /** Resolves a sender address without throwing (used to default Solana recipient at quote time). */
    async resolveSenderOrUndefined() {
        if (this.account?.getAddress)
            return this.account.getAddress();
        return this.config.evm?.walletClient?.account?.address;
    }
    assertExecutionCapability() {
        if (this.isBuiltInEvmExecution()) {
            const canSend = Boolean(this.account?.sendTransaction ||
                this.config.evm?.sendTransaction ||
                this.config.evm?.walletClient);
            if (!canSend)
                throw new ButterReadOnlyAccountError();
            // A raw evm.sendTransaction carries no address; without an account or a
            // wallet client we cannot determine the sender, so reject early with a
            // specific error instead of a misleading read-only failure later.
            if (!this.hasSenderAddress()) {
                throw new ButterConfigurationError('evm.sendTransaction requires evm.walletClient (with an account) or a WDK account to determine the sender address');
            }
            return;
        }
        if (!this.config.transactionAdapters?.[this.sourceChainId]) {
            throw new ButterConfigurationError(`No transaction adapter configured for chain ${this.sourceChainId}`);
        }
        if (!this.account?.sendTransaction)
            throw new ButterReadOnlyAccountError();
    }
    feeContextFor(sourceToken) {
        return { ...this.feeContext, sourceToken };
    }
}
function hashOf(result) {
    if (typeof result === 'string')
        return result;
    if (result.hash)
        return result.hash;
    throw new ButterConfigurationError('Transaction sender did not return a hash');
}
function sameRecipient(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
/** Normalizes the optional Butter `routeHash` pin, treating empty strings as absent. */
function normalizeRouteHash(hash) {
    return typeof hash === 'string' && hash.length > 0 ? hash : undefined;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.js.map