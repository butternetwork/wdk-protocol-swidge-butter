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
import { addressFamilyForChain, DEFAULT_APP_BASE_URL, DEFAULT_ROUTER_BASE_URL, DEFAULT_TOKEN_BASE_URL, OPERATION_KIND_MAX_ENTRIES, REQUEST_TIMEOUT_MS, ROUTE_TTL_SECONDS, SOLANA_CHAIN_ID, TRON_CHAIN_ID } from './constants.js';
import { assertBaseUnitAmount } from './amounts.js';
import { normalizeTokenKey, normalizeTransactionHash } from './identifiers.js';
import { ButterHttpClient } from './http.js';
import { RouteManager } from './route.js';
import { enforceFeeLimits, resolveFeeLimits, routeNativeFee, validateFeeLimits } from './fees.js';
import { routeToQuote } from './mappers.js';
import { DiscoveryService } from './discovery.js';
import { routerFunctionName, validateSwapTransactions } from './swap-data.js';
import { assertGasFee, assertTransactionHash, executeEvmSwap, isNativeToken } from './evm.js';
import { mapReceiptStatus, mapStatusResponse } from './status.js';
import { createRouterRegistry, routerDeploymentsForChain } from './router-registry.js';
import { ButterActionRequiredError, ButterApiError, ButterConfigurationError, ButterExactOutUnsupportedError, ButterPartialExecutionError, ButterReadOnlyAccountError, ButterUnsupportedError } from './errors.js';
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
    maxNativeFee;
    /** Caller-supplied EVM chain ids, normalized, for the address-family check. */
    evmChainIds;
    // Remembers whether an executed operation was same- or cross-chain, keyed by
    // source hash, so getSwidgeStatus can route correctly when the caller omits
    // the optional fromChain/toChain hints. Instance-scoped (like the route cache).
    operationKinds = new Map();
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
        const maxNativeFee = parseMaxNativeFee(config.maxNativeFee);
        const executionMarginSeconds = parseExecutionMarginSeconds(config.routeExecutionMarginSeconds);
        const requestTimeoutMs = parseTimeoutMs(config.requestTimeoutMs, 'requestTimeoutMs', false) ?? REQUEST_TIMEOUT_MS;
        parseTimeoutMs(config.evm?.approvalTimeoutMs, 'approvalTimeoutMs', true);
        const affiliate = parseAffiliate(config.affiliate);
        const referrer = normalizeOptionalText(config.referrer);
        const fetchImpl = config.fetch ?? globalThis.fetch;
        if (!fetchImpl) {
            throw new ButterConfigurationError('A fetch implementation is required');
        }
        // ButterAccount is a structural subset of the WDK account interfaces; the
        // base class only stores the reference, so the widening cast is safe.
        super(account, config);
        this.account = account;
        this.config = config;
        this.maxNativeFee = maxNativeFee;
        this.evmChainIds = new Set((config.evmChainIds ?? []).map((id) => String(id)));
        this.sourceChainId = String(config.sourceChainId);
        this.routerRegistry = createRouterRegistry(config.routerContracts);
        this.feeContext = {
            sourceChainId: this.sourceChainId,
            sourceToken: '',
            ...(config.nativeTokenDecimals ? { nativeTokenDecimals: config.nativeTokenDecimals } : {}),
            ...(config.onWarning ? { onWarning: config.onWarning } : {})
        };
        this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
        this.http = new ButterHttpClient({
            routerBaseUrl: config.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL,
            tokenBaseUrl: config.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL,
            appBaseUrl: config.appBaseUrl ?? DEFAULT_APP_BASE_URL,
            fetch: fetchImpl,
            requestTimeoutMs,
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
            tokenDecimals: normalizedTokenDecimals(config.tokenDecimals),
            nativeTokenDecimals: config.nativeTokenDecimals ?? {},
            strictSlippageChainIds,
            ...(executionMarginSeconds != null ? { executionMarginSeconds } : {}),
            ...(affiliate != null ? { affiliate } : {}),
            ...(referrer != null ? { referrer } : {}),
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
        options = normalizeRecipient(options);
        this.assertQuoteOptions(options);
        // The sender fallback is only used to default the receiver for a Solana
        // source; avoid an unnecessary getAddress() call for every other chain.
        const senderFallback = this.sourceChainId === SOLANA_CHAIN_ID ? await this.resolveSenderOrUndefined() : undefined;
        const cached = await this.routes.getRoute(options, { senderFallback });
        this.routes.enforceMinAmountOut(options, cached.route);
        const quoteFeeContext = {
            ...this.feeContextFor(options.fromToken),
            sourceTokenDecimals: cached.sourceDecimals
        };
        const quote = routeToQuote(cached.route, this.now, cached.expiresAt, quoteFeeContext, options.fromTokenAmount);
        return {
            ...quote,
            routeHash: cached.route.hash,
            destinationGuarantees: this.destinationGuaranteesFor(options)
        };
    }
    /**
     * Reports whether `toTokenAmountMin` is checked against the calldata at execution.
     *
     * Only same-chain is: cross-chain leaves the destination minimum inside the
     * nested bridge payload, which is trusted to Butter by design.
     */
    destinationGuaranteesFor(options) {
        const destinationChainId = String(options.toChain ?? this.sourceChainId);
        return destinationChainId === this.sourceChainId ? 'enforced' : 'quoted-only';
    }
    /** Executes an exact-in operation after validating route fees and transaction intent. */
    async swidge(options, config = {}) {
        options = normalizeRecipient(options);
        this.assertQuoteOptions(options);
        this.assertExecutionCapability();
        const sender = await this.getSender();
        // WDK defaults the recipient to the account address, which is only safe while
        // the destination chain speaks the same address format. Across families the
        // source sender is not a spendable address on the destination chain, and the
        // /swap stage — where this default is first used as the destination receiver —
        // would send it anyway. Enforced only here, never in quoteSwidge: quoting
        // without a recipient is the normal way to ask a price.
        const destinationChainId = String(options.toChain ?? this.sourceChainId);
        const sourceFamily = addressFamilyForChain(this.sourceChainId, this.evmChainIds);
        const destinationFamily = addressFamilyForChain(destinationChainId, this.evmChainIds);
        // An `unknown` family on either side also requires an explicit recipient, and
        // must not be allowed to "match" the other side: two unknowns are not evidence
        // of a shared address format. Butter adds chains without this package being
        // republished, so an unrecognized destination is exactly where a silently
        // reused `0x` sender would land somewhere unspendable.
        const unknownFamily = sourceFamily === 'unknown' || destinationFamily === 'unknown';
        if (options.recipient == null && (unknownFamily || sourceFamily !== destinationFamily)) {
            throw new ButterActionRequiredError('Butter requires an explicit recipient when the destination chain uses a different or unrecognized address format', {
                sourceChainId: this.sourceChainId,
                sourceFamily,
                destinationChainId,
                destinationFamily
            });
        }
        const receiver = options.recipient ?? sender;
        const maxNativeFee = parseMaxNativeFee(options.maxNativeFee) ?? this.maxNativeFee;
        const pinnedHash = normalizeRouteHash(options.routeHash);
        const cached = pinnedHash != null
            ? await this.routes.consumeRouteByHash(pinnedHash, options, sender)
            : await this.routes.getRoute(options, { forExecution: true, senderFallback: sender });
        this.routes.enforceMinAmountOut(options, cached.route);
        // assertQuoteOptions guarantees a valid, positive exact-in amount.
        const requestedAmountIn = BigInt(options.fromTokenAmount);
        const feeContext = {
            ...this.feeContextFor(options.fromToken),
            sourceTokenDecimals: cached.sourceDecimals,
            requestedAmountIn
        };
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
            destinationChainId,
            route: cached.route,
            routerRegistry: this.routerRegistry,
            nativeSource,
            minimumAmountOut: quote.toTokenAmountMin,
            sender,
            receiver,
            sourceToken: options.fromToken,
            destinationToken: options.toToken,
            requireRouterAllowlist: this.isBuiltInEvmExecution(),
            // Only forwarded when the caller named one: an absent refundAddress leaves
            // Butter's own default in place and the nested payload undecoded.
            ...(options.refundAddress ? { refundAddress: options.refundAddress } : {}),
            routerNativeFee: routeNativeFee(cached.route, feeContext),
            requestedAmountIn,
            ...(maxNativeFee != null ? { maxNativeFee } : {}),
            ...(cached.route.feeConfig ? { feeConfig: cached.route.feeConfig } : {})
        };
        const swapTransactions = validateSwapTransactions(swapData, swapValidationContext);
        const transactions = [];
        // One entry per execution unit; undefined means that unit's gas was not
        // measured. Only fold in a measured fee when EVERY unit reported one.
        const feeParts = [];
        const toChain = destinationChainId;
        if (this.isBuiltInEvmExecution()) {
            // The built-in EVM path is exactly one Router transaction (enforced by
            // validateSwapTransactions); executeEvmSwap adds any approval + the source.
            for (const swapTx of swapTransactions) {
                try {
                    const executed = await executeEvmSwap({
                        account: this.account,
                        config: this.config,
                        sender,
                        route: cached.route,
                        swapTx,
                        options,
                        sourceChainId: this.sourceChainId,
                        nativeSource,
                        // Exact-in: the caller's own input, which the calldata was validated to
                        // equal exactly. A caller-chosen bound, never Butter's.
                        approvalAmount: requestedAmountIn
                    });
                    transactions.push(...executed.transactions);
                    feeParts.push(executed.gasFee);
                }
                catch (cause) {
                    // executeEvmSwap reports its own broadcast transactions; merge them
                    // with anything already sent so the caller sees the full picture.
                    if (cause instanceof ButterPartialExecutionError) {
                        transactions.push(...cause.transactions);
                        throw this.partialExecution(transactions, cause.cause, toChain, cause.failedType ?? 'source');
                    }
                    throw this.partialExecution(transactions, cause, toChain, 'source');
                }
            }
        }
        else {
            const adapter = this.config.transactionAdapters?.[this.sourceChainId];
            if (!adapter)
                throw new ButterUnsupportedError(`No transaction adapter configured for chain ${this.sourceChainId}`);
            if (!this.account?.sendTransaction)
                throw new ButterUnsupportedError('An account with sendTransaction is required for adapter execution');
            const sendTransaction = this.account.sendTransaction.bind(this.account);
            // Normalize and CLASSIFY every adapter output BEFORE broadcasting any of
            // them. A partial broadcast that then fails classification would leave
            // already-sent transactions a retry could double-execute, so all validation
            // (legal types, exactly one `source`) must complete before the first send.
            const adapted = swapTransactions.map((swapTx) => normalizeAdapterResult(adapter(swapTx, { sender, receiver, route: cached.route, options })));
            const classified = resolveAdapterTypes(adapted);
            for (const entry of classified) {
                // The whole body is guarded, not just the await: hashOf/feeOf can also
                // throw AFTER the transaction has gone out.
                try {
                    const result = await sendTransaction(entry.transaction);
                    transactions.push({ hash: hashOf(result), chain: this.sourceChainId, type: entry.type });
                    feeParts.push(feeOf(result));
                }
                catch (cause) {
                    throw this.partialExecution(transactions, cause, toChain, entry.type);
                }
            }
        }
        // Everything below runs with the transactions already on the wire, so any
        // failure here — totalling the fees, assembling the result — must still
        // report what was broadcast rather than propagating bare.
        try {
            const sourceTx = transactions.find((tx) => tx.type === 'source');
            if (!sourceTx) {
                // Every validated swap transaction produces a source entry; reaching
                // this indicates a bug rather than a recoverable condition.
                throw new ButterApiError('Butter execution produced no source transaction', { transactions });
            }
            this.rememberOperationKind(sourceTx.hash, toChain);
            const actualNetworkFee = feeParts.length > 0 && feeParts.every((fee) => fee != null)
                ? feeParts.reduce((total, fee) => total + (fee ?? 0n), 0n)
                : undefined;
            return {
                id: sourceTx.hash,
                hash: sourceTx.hash,
                fees: actualNetworkFee != null ? withMeasuredNetworkFee(quote.fees, actualNetworkFee, cached.route) : quote.fees,
                transactions,
                fromTokenAmount: quote.fromTokenAmount,
                toTokenAmount: quote.toTokenAmount,
                toTokenAmountMin: quote.toTokenAmountMin
            };
        }
        catch (cause) {
            throw this.partialExecution(transactions, cause, toChain, 'source');
        }
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
        if (!options.byOrderId) {
            const recorded = this.operationKinds.get(normalizeTransactionHash(id));
            if (recorded != null) {
                // Recorded by this instance → trusted attribution; no re-verification.
                if (recorded.fromChain === recorded.toChain)
                    return this.getSameChainStatus(id, recorded.fromChain);
            }
            else {
                // Not recorded: only treat as same-chain after verifying the source tx
                // actually belongs to a Butter Router (allowlisted target + swapAndCall).
                // Explicit hints do NOT bypass this — an unrelated tx must never be
                // reported as a completed swidge (WDK: an unknown id should throw).
                const attribution = await this.attributeSourceTransaction(id);
                if (attribution === 'same')
                    return this.getSameChainStatus(id, this.sourceChainId);
                const hintedSameChain = options.fromChain != null && options.toChain != null &&
                    String(options.fromChain) === String(options.toChain);
                if (attribution == null && hintedSameChain) {
                    throw new ButterApiError('Cannot verify a same-chain Butter swidge: source transaction is not an allowlisted Router swapAndCall on this chain (configure evm.publicClient.getTransaction)', { id });
                }
                // attribution 'cross', or unresolved without same-chain hints → cross API.
            }
        }
        const data = options.byOrderId
            ? await this.http.app('/api/queryCrossInfoByOrderId', { orderId: id })
            : await this.http.app('/api/queryBridgeInfoBySourceHash', { hash: id });
        return mapStatusResponse(id, data, options);
    }
    /**
     * Builds the error to throw when a send fails part-way through execution.
     *
     * Returns the original `cause` untouched when nothing was broadcast (rejected
     * in the wallet, RPC refused): that is an ordinary failure, not a partially
     * applied operation, and callers still match on the underlying error type.
     * Once at least one transaction is on-chain the failure is wrapped in a
     * {@link ButterPartialExecutionError} carrying every broadcast hash, so a
     * caller cannot mistake it for "nothing happened" and retry into a double
     * execution. A broadcast `source` transaction is also registered for status
     * routing before throwing — the swidge is in flight even though this call
     * failed, and `getSwidgeStatus` must still resolve it.
     */
    partialExecution(transactions, cause, toChain, failedType) {
        if (transactions.length === 0)
            return cause;
        const sourceTx = transactions.find((tx) => tx.type === 'source');
        if (sourceTx) {
            try {
                this.rememberOperationKind(sourceTx.hash, toChain);
            }
            catch {
                // Unreachable: hashes are validated at the sender boundary, so the key
                // is always a string. Kept as a backstop because this is the last-resort
                // reporter — registering for status routing is best-effort, but handing
                // the caller its broadcast hashes is not, and must not be lost to a
                // failure raised while reporting.
            }
        }
        return new ButterPartialExecutionError(transactions, cause, failedType);
    }
    /** Records an executed operation's chain kind for later status routing, bounding memory. */
    rememberOperationKind(sourceHash, toChain) {
        // Must use the same normalizer as the lookup in getSwidgeStatus, and the
        // transaction-hash one: lowercasing a Base58 signature would file two different
        // transactions under one key, while the token-identifier rule would file one BTC
        // txid under two.
        const key = normalizeTransactionHash(sourceHash);
        this.operationKinds.delete(key);
        this.operationKinds.set(key, { fromChain: this.sourceChainId, toChain });
        while (this.operationKinds.size > OPERATION_KIND_MAX_ENTRIES) {
            const oldest = this.operationKinds.keys().next().value;
            if (oldest === undefined)
                break;
            this.operationKinds.delete(oldest);
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
    async attributeSourceTransaction(hash) {
        const getTransaction = this.config.evm?.publicClient?.getTransaction;
        if (!getTransaction)
            return undefined;
        // A not-found transaction resolves to null (unattributable); infrastructure
        // errors intentionally propagate.
        const tx = await getTransaction(hash);
        if (!tx?.to || !this.isAllowlistedRouter(tx.to))
            return undefined;
        const fn = routerFunctionName(tx.input);
        if (fn === 'swapAndCall')
            return 'same';
        if (fn === 'swapAndBridge')
            return 'cross';
        return undefined;
    }
    /** True when the address is an allowlisted Router deployment on the source chain. */
    isAllowlistedRouter(address) {
        const normalized = address.toLowerCase();
        return routerDeploymentsForChain(this.routerRegistry, this.sourceChainId)
            .some((deployment) => deployment.address.toLowerCase() === normalized);
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
     * Butter Router only supports per-chain listing.
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
        // Exact-out is rejected before any network request. Butter's `/route` documents
        // `type: exactOut`, but the default production endpoint rejects it with
        // errno 2000 ("Parameter error"), and the docs describe `amount` only as
        // "amount of source token" with no exactOut variant — so even the denomination
        // to send is unspecified. Advertising it would be advertising a feature that
        // does not work. `npm run example:probe-exact-out` re-checks both against the
        // live API; the execution-side plumbing (maxAmountIn / assertSourceAmountIn) is
        // retained and tested, so re-enabling is a small change once Butter confirms.
        if (hasOutput)
            throw new ButterExactOutUnsupportedError();
        if (hasInput === hasOutput) {
            throw new ButterUnsupportedError('fromTokenAmount is required');
        }
        assertBaseUnitAmount(options.fromTokenAmount, 'fromTokenAmount');
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
    /** Resolves a sender address without throwing (used to default Solana recipient at quote time). */
    async resolveSenderOrUndefined() {
        if (this.account?.getAddress)
            return this.account.getAddress();
        return this.config.evm?.walletClient?.account?.address;
    }
    assertExecutionCapability() {
        if (this.isBuiltInEvmExecution()) {
            // WDK contract: swidge() requires a full (send-capable) account — reject
            // undefined or read-only accounts up front, matching the interface's
            // documented behavior.
            if (!this.account?.sendTransaction)
                throw new ButterReadOnlyAccountError();
            // A full account still cannot carry the swap/approval calldata: the WDK
            // `Transaction` type is only `{ to, value }`, so `data`/`chainId` would be
            // dropped. An EVM-capable sender (`evm.walletClient`) is additionally
            // required; the account is used only for address resolution and receipt
            // polling. (This can merge once WDK extends `Transaction` with `data`.)
            if (!this.config.evm?.walletClient) {
                throw new ButterReadOnlyAccountError('Butter EVM Router execution requires evm.walletClient to carry the swap calldata; the WDK account cannot (its Transaction type is only { to, value })');
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
/**
 * Extracts the transaction hash from an adapter send, under the same
 * runtime rule as the built-in EVM path — an adapter is host-supplied too, so
 * the declared `string` is not a runtime guarantee.
 */
function hashOf(result) {
    return assertTransactionHash(typeof result === 'string' ? result : result.hash);
}
/**
 * Normalizes a transaction adapter's return into `{ transaction, type }`. An
 * object carrying a `transaction` property is the explicit form; anything else
 * is treated as a bare transaction with an unknown role.
 */
function normalizeAdapterResult(value) {
    if (value != null && typeof value === 'object' && 'transaction' in value) {
        const wrapped = value;
        return { transaction: wrapped.transaction, type: wrapped.type };
    }
    return { transaction: value, type: undefined };
}
/** Legal `SwidgeTransaction` roles an adapter may declare. */
const ADAPTER_TYPES = new Set(['source', 'destination', 'approval', 'refund', 'other']);
function isAdapterType(value) {
    return typeof value === 'string' && ADAPTER_TYPES.has(value);
}
/**
 * Validates and resolves the roles of an adapter's normalized outputs BEFORE any
 * are broadcast. Every explicit type must be a legal `SwidgeTransaction` role; a
 * multi-transaction result must classify each entry; and the set must contain
 * exactly one `source` (the operation id and status anchor). A single untyped
 * transaction defaults to `source`. Throws so nothing is sent on any violation.
 */
function resolveAdapterTypes(adapted) {
    for (const entry of adapted) {
        if (entry.type != null && !isAdapterType(entry.type)) {
            throw new ButterUnsupportedError(`Adapter returned an unknown transaction type: ${String(entry.type)}`);
        }
    }
    // A multi-transaction adapter must classify each transaction so the primary
    // `source` (used as the operation id and for status) is unambiguous.
    if (adapted.length > 1 && adapted.some((entry) => entry.type == null)) {
        throw new ButterUnsupportedError('Adapter returned multiple transactions without an explicit type; return { transaction, type } for each so the source transaction is identifiable');
    }
    const resolved = adapted.map((entry) => ({ transaction: entry.transaction, type: entry.type ?? 'source' }));
    const sources = resolved.filter((entry) => entry.type === 'source').length;
    if (sources !== 1) {
        throw new ButterUnsupportedError(`Adapter must produce exactly one source transaction, but produced ${sources}`);
    }
    return resolved;
}
/** Extracts a gas fee reported by a transaction sender, rejecting anything but a non-negative bigint. */
function feeOf(result) {
    if (typeof result === 'string')
        return undefined;
    // Same non-negative-bigint rule as the built-in EVM path; an adapter is
    // host-supplied too, so the declared `bigint` is not a runtime guarantee.
    return assertGasFee(result.fee);
}
/**
 * Replaces the estimated network fee with the measured source gas fee, so the
 * result reports what was actually charged. The other (bridge/protocol) fees
 * remain route-derived estimates. If the quote had no network entry, one is
 * appended when a native fee token can be identified.
 */
function withMeasuredNetworkFee(fees, measured, route) {
    let replaced = false;
    const next = fees.map((fee) => {
        if (!replaced && fee.type === 'network') {
            replaced = true;
            return { ...fee, amount: measured, description: 'Measured source gas fee' };
        }
        return fee;
    });
    if (!replaced) {
        const token = route.gasFee?.address ?? route.gasFee?.symbol;
        if (token) {
            next.push({ type: 'network', amount: measured, token, included: false, description: 'Measured source gas fee' });
        }
    }
    return next;
}
function sameRecipient(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
/**
 * Indexes configured token decimals under the same key function the lookup uses.
 *
 * Normalizing only at query time left a checksummed configuration key unreachable by
 * the equivalent lowercase request — both the raw and the normalized lookup missed —
 * so configured decimals were reported as missing. That went unnoticed because a
 * successful `/findToken` covers for it.
 *
 * Two entries that normalize together must agree: silently keeping one would make
 * which decimals apply depend on object key order, and decimals decide amounts.
 */
function normalizedTokenDecimals(configured) {
    const decimals = new Map();
    for (const [token, value] of Object.entries(configured ?? {})) {
        const key = normalizeTokenKey(token);
        const existing = decimals.get(key);
        if (existing != null && existing !== value) {
            throw new ButterConfigurationError('tokenDecimals has conflicting entries for the same token', {
                token,
                decimals: [existing, value]
            });
        }
        decimals.set(key, value);
    }
    return decimals;
}
/** Validates and normalizes the optional maxNativeFee cap to native base units. */
function parseMaxNativeFee(value) {
    if (value == null)
        return undefined;
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
        throw new ButterConfigurationError('maxNativeFee must be a non-negative integer in native base units');
    }
    const result = BigInt(value);
    if (result < 0n)
        throw new ButterConfigurationError('maxNativeFee must be a non-negative integer in native base units');
    return result;
}
/** Validates the optional execution-path route freshness margin, in seconds. */
function parseExecutionMarginSeconds(value) {
    if (value == null)
        return undefined;
    if (!Number.isFinite(value) || value < 0 || value >= ROUTE_TTL_SECONDS) {
        throw new ButterConfigurationError(`routeExecutionMarginSeconds must be a non-negative number below the ${ROUTE_TTL_SECONDS}s route lifetime`);
    }
    return value;
}
/** Validates a millisecond deadline supplied by an integrator. */
function parseTimeoutMs(value, label, allowZero) {
    if (value == null)
        return undefined;
    const minimum = allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new ButterConfigurationError(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer number of milliseconds`);
    }
    return value;
}
/** Treats a blank or whitespace-only configuration string as absent. */
function normalizeOptionalText(value) {
    if (value == null)
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/** Normalizes recipient once so route keys, requests, and execution share its semantics. */
function normalizeRecipient(options) {
    const recipient = normalizeOptionalText(options.recipient);
    if (recipient === options.recipient)
        return options;
    const { recipient: _discarded, ...rest } = options;
    return (recipient == null ? rest : { ...rest, recipient });
}
/**
 * Validates the optional Butter affiliate, documented as `<nickname>[:rate]`.
 *
 * Checked at construction rather than on the first request because Butter
 * substitutes its own default affiliate wallet whenever the parameter is absent
 * or unusable: a malformed value would otherwise hand the integrator's share
 * away silently, with a successful swap and no error to notice.
 */
function parseAffiliate(value) {
    const affiliate = normalizeOptionalText(value);
    if (affiliate == null)
        return undefined;
    const [nickname, rate, ...rest] = affiliate.split(':');
    if (!nickname || rest.length > 0 || /\s/.test(affiliate)) {
        throw new ButterConfigurationError('affiliate must be formatted as "<nickname>" or "<nickname>:<rate>"');
    }
    // `Number('')` is 0, so the empty-rate case ("nickname:") needs its own test.
    if (rate !== undefined && (rate.length === 0 || !Number.isFinite(Number(rate)) || Number(rate) < 0)) {
        throw new ButterConfigurationError('affiliate rate must be a non-negative number');
    }
    return affiliate;
}
/** Normalizes the optional Butter `routeHash` pin, treating empty strings as absent. */
function normalizeRouteHash(hash) {
    return typeof hash === 'string' && hash.length > 0 ? hash : undefined;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.js.map