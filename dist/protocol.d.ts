import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
import type { ButterAccount, ButterSupportedChain, ButterSwidgeOptions, ButterSwidgeProtocolConfig, ButterSwidgeQuote, ButterSwidgeStatusOptions, SwidgeOptions, SwidgeProtocolConfig, SwidgeResult, SwidgeStatusResult, SwidgeSupportedToken, SwidgeSupportedTokensOptions } from './types.js';
/** Butter Smart Router implementation of the WDK Swidge protocol. */
export declare class ButterSwidgeProtocol extends SwidgeProtocol {
    private readonly account;
    private readonly config;
    private readonly http;
    private readonly routes;
    private readonly discovery;
    private readonly now;
    private readonly sourceChainId;
    private readonly routerRegistry;
    private readonly feeContext;
    private readonly maxNativeFee;
    /** Caller-supplied EVM chain ids, normalized, for the address-family check. */
    private readonly evmChainIds;
    private readonly operationKinds;
    /**
     * Creates a protocol instance bound to one source chain.
     *
     * @param {ButterAccount | undefined} account - The WDK account bound to the protocol instance.
     * @param {ButterSwidgeProtocolConfig} config - The source-chain, API, fee, routing, and execution configuration.
     * @throws {ButterConfigurationError} If required integration metadata, fee limits, timeouts, Router deployments, credentials, or source-chain settings are invalid.
     */
    constructor(account: ButterAccount | undefined, config: ButterSwidgeProtocolConfig);
    /**
     * Returns a non-binding exact-in quote without requiring execution capability.
     *
     * Fee caps are intentionally not enforced here: a quote must remain a fully
     * inspectable estimate (WDK only mandates rejection in {@link swidge}). Fee
     * limits are applied at execution time.
     *
     * The returned quote carries `routeHash`; pass it back as `options.routeHash`
     * to {@link swidge} to pin this exact route instead of auto-re-quoting.
     *
     * @param {SwidgeOptions} options - The caller-supplied operation options.
     * @returns {Promise<ButterSwidgeQuote>} The non-binding quote with Butter route hash and destination guarantees.
     * @throws {ButterExactOutUnsupportedError} If exact-out options are supplied.
     * @throws {ButterUnsupportedError} If required tokens or the exact-in amount are missing or invalid.
     * @throws {ButterActionRequiredError} If route requirements such as slippage, receiver, or minimum output need caller action.
     * @throws {ButterNoRouteError} If Butter provides no liquid route.
     * @throws {ButterApiError} If Butter returns malformed or inconsistent route or fee data.
     * @throws {ButterFeeValuationError} If a reported fee cannot be mapped using trustworthy token metadata.
     */
    quoteSwidge(options: SwidgeOptions): Promise<ButterSwidgeQuote>;
    /** @private */
    private destinationGuaranteesFor;
    /**
     * Executes an exact-in operation after validating route fees and transaction intent.
     *
     * @param {ButterSwidgeOptions} options - The caller-supplied operation options.
     * @param {SwidgeProtocolConfig} [config] - The configuration used by the operation (default: empty object).
     * @returns {Promise<SwidgeResult>} The executed WDK result and every broadcast transaction.
     * @throws {ButterExactOutUnsupportedError} If exact-out options are supplied.
     * @throws {ButterUnsupportedError} If the requested route, adapter output, or operation shape is unsupported.
     * @throws {ButterReadOnlyAccountError} If execution lacks a send-capable WDK account or EVM wallet client.
     * @throws {ButterConfigurationError} If execution configuration, sender identity, approval confirmation, or native-fee bounds are invalid.
     * @throws {ButterActionRequiredError} If the recipient, slippage, quote freshness, or minimum output needs caller action.
     * @throws {ButterNoRouteError} If Butter provides no liquid route.
     * @throws {ButterFeeValuationError} If a configured fee cap cannot value Butter's fee metadata safely.
     * @throws {ButterFeeLimitExceededError} If the route exceeds a configured network or protocol fee cap.
     * @throws {ButterTransactionValidationError} If `/swap` transaction data does not match the quoted intent or configured limits.
     * @throws {ButterPartialExecutionError} If a send or confirmation fails after at least one transaction was broadcast.
     * @throws {ButterApiError} If Butter returns malformed or inconsistent data or a sender reports invalid metadata.
     */
    swidge(options: ButterSwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>;
    /**
     * Retrieves a Butter operation by source hash or, when requested, order ID.
     *
     * Same-chain swaps produce no Butter cross-chain record, so when the caller
     * indicates a same-chain operation (`fromChain === toChain`) the status is
     * derived from the transaction receipt instead of the cross-chain APIs.
     *
     * @param {string} id - The identifier to normalize or query.
     * @param {ButterSwidgeStatusOptions} [options] - The caller-supplied operation options (default: empty object).
     * @returns {Promise<SwidgeStatusResult>} The conservative WDK status and any reported source or destination transactions.
     * @throws {ButterApiError} If the id is empty, attribution fails, or Butter returns missing or inconsistent status data.
     * @throws {ButterConfigurationError} If same-chain receipt status cannot be queried with the configured clients.
     */
    getSwidgeStatus(id: string, options?: ButterSwidgeStatusOptions): Promise<SwidgeStatusResult>;
    /** @private */
    private partialExecution;
    /** @private */
    private rememberOperationKind;
    /** @private */
    private attributeSourceTransaction;
    /** @private */
    private isAllowlistedRouter;
    /** @private */
    private getSameChainStatus;
    /**
     * Lists chains currently advertised by Butter Router.
     *
     * Each entry carries an `execution` field (`native` | `adapter` |
     * `quote-only`) describing how this instance would execute on that chain.
     *
     * @returns {Promise<ButterSupportedChain[]>} The validated chains with native, adapter, or quote-only execution capability.
     * @throws {ButterApiError} If Butter returns malformed chain metadata.
     */
    getSupportedChains(): Promise<ButterSupportedChain[]>;
    /**
     * Lists the non-exhaustive token catalog currently advertised by Butter Router.
     *
     * Catalog membership is not a route capability check: Butter can route tokens
     * omitted here by swapping on the source and destination chains. Chain selection
     * uses `fromChain`, then `toChain`, then the instance's source chain. Route-scoped
     * `fromToken` filtering is unavailable from Butter Router's per-chain listing.
     *
     * @param {SwidgeSupportedTokensOptions} [options] - The caller-supplied operation options (default: empty object).
     * @returns {Promise<SwidgeSupportedToken[]>} The validated token catalog for the selected chain.
     * @throws {ButterApiError} If Butter returns malformed, wrong-chain, or conflicting token metadata.
     */
    getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
    /** @private */
    private assertQuoteOptions;
    /** @private */
    private isBuiltInEvmExecution;
    /** @private */
    private getSender;
    /** @private */
    private resolveSenderOrUndefined;
    /** @private */
    private assertExecutionCapability;
    /** @private */
    private feeContextFor;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.d.ts.map