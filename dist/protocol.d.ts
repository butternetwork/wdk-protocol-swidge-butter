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
     * @throws {ButterConfigurationError} If required configuration is absent, malformed, insecure, or internally inconsistent.
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
     * @throws {ButterUnsupportedError} If the request uses unsupported or invalid quote options.
     * @throws {ButterExactOutUnsupportedError} If the request asks for an exact output amount.
     * @throws {ButterConfigurationError} If required local token metadata or Solana referrer configuration is absent.
     * @throws {ButterNoRouteError} If Butter reports no liquid route for the requested pair.
     * @throws {ButterFeeValuationError} If reported fee metadata cannot be valued safely.
     * @throws {ButterApiError} If a Butter request fails or its response is malformed or inconsistent.
     */
    quoteSwidge(options: SwidgeOptions): Promise<ButterSwidgeQuote>;
    /**
     * Reports whether `toTokenAmountMin` is checked against the calldata at execution.
     *
     * Only same-chain is: cross-chain leaves the destination minimum inside the
     * nested bridge payload, which is trusted to Butter by design.
     */
    private destinationGuaranteesFor;
    /**
     * Executes an exact-in operation after validating route fees and transaction intent.
     *
     * @throws {ButterUnsupportedError} If the request or configured execution path is unsupported.
     * @throws {ButterExactOutUnsupportedError} If the request asks for an exact output amount.
     * @throws {ButterConfigurationError} If required execution, fee, Router, signer, or receipt configuration is absent or invalid.
     * @throws {ButterReadOnlyAccountError} If execution lacks a send-capable WDK account or EVM wallet client.
     * @throws {ButterActionRequiredError} If a cross-family recipient or another caller decision is required.
     * @throws {ButterFeeLimitExceededError} If a reported fee exceeds a configured WDK fee cap.
     * @throws {ButterFeeValuationError} If a configured fee cap cannot be evaluated safely.
     * @throws {ButterTransactionValidationError} If `/swap` transaction data does not match the validated route and caller intent.
     * @throws {ButterNoRouteError} If Butter reports no liquid route for the requested pair.
     * @throws {ButterApiError} If a Butter request fails or its response is malformed or inconsistent.
     * @throws {ButterPartialExecutionError} If execution fails after one or more identifiable transactions were broadcast.
     */
    swidge(options: ButterSwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>;
    /**
     * Retrieves a Butter operation by source hash or, when requested, order ID.
     *
     * Same-chain swaps produce no Butter cross-chain record, so when the caller
     * indicates a same-chain operation (`fromChain === toChain`) the status is
     * derived from the transaction receipt instead of the cross-chain APIs.
     *
     * @throws {ButterApiError} If the identifier is empty, cannot be attributed safely, or Butter returns malformed status data.
     * @throws {ButterConfigurationError} If same-chain status lookup lacks a transaction or receipt client.
     * @throws {Error} If the configured RPC client fails for a reason other than transaction not-found.
     */
    getSwidgeStatus(id: string, options?: ButterSwidgeStatusOptions): Promise<SwidgeStatusResult>;
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
    private partialExecution;
    /** Records an executed operation's chain kind for later status routing, bounding memory. */
    private rememberOperationKind;
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
    private attributeSourceTransaction;
    /** True when the address is an allowlisted Router deployment on the source chain. */
    private isAllowlistedRouter;
    private getSameChainStatus;
    /**
     * Lists chains currently advertised by Butter Router.
     *
     * Each entry carries an `execution` field (`native` | `adapter` |
     * `quote-only`) describing how this instance would execute on that chain.
     *
     * @throws {ButterApiError} If Butter discovery fails or returns malformed chain collections.
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
     * @throws {ButterApiError} If Butter discovery fails or returns malformed or conflicting token metadata.
     */
    getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
    private assertQuoteOptions;
    private isBuiltInEvmExecution;
    private getSender;
    /** Resolves a sender address without throwing (used to default Solana recipient at quote time). */
    private resolveSenderOrUndefined;
    private assertExecutionCapability;
    private feeContextFor;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.d.ts.map