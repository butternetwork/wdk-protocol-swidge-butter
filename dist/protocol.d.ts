import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
import type { ButterAccount, ButterSupportedChain, ButterSwidgeOptions, ButterSwidgeProtocolConfig, ButterSwidgeQuote, SwidgeOptions, SwidgeProtocolConfig, SwidgeResult, SwidgeStatusResult, SwidgeSupportedToken, SwidgeSupportedTokensOptions } from './types.js';
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
    /** Creates a protocol instance bound to one source chain. */
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
     */
    quoteSwidge(options: SwidgeOptions): Promise<ButterSwidgeQuote>;
    /** Executes an exact-in operation after validating route fees and transaction intent. */
    swidge(options: ButterSwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>;
    /**
     * Retrieves a Butter operation by source hash or, when requested, order ID.
     *
     * Same-chain swaps produce no Butter cross-chain record, so when the caller
     * indicates a same-chain operation (`fromChain === toChain`) the status is
     * derived from the transaction receipt instead of the cross-chain APIs.
     */
    getSwidgeStatus(id: string, options?: {
        byOrderId?: boolean;
        fromChain?: string | number;
        toChain?: string | number;
    }): Promise<SwidgeStatusResult>;
    private getSameChainStatus;
    /**
     * Lists chains currently advertised by Butter Router.
     *
     * Each entry carries an `execution` field (`native` | `adapter` |
     * `quote-only`) describing how this instance would execute on that chain.
     */
    getSupportedChains(): Promise<ButterSupportedChain[]>;
    /**
     * Lists all Butter-supported tokens for the selected chain.
     *
     * Chain selection uses `fromChain`, then `toChain`, then the instance's
     * source chain. Route-scoped `fromToken` filtering is not implemented:
     * Butter's token API only supports per-chain listing.
     */
    getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
    private assertQuoteOptions;
    private isBuiltInEvmExecution;
    private getSender;
    /** Returns true when a sender address can be derived from the configuration. */
    private hasSenderAddress;
    /** Resolves a sender address without throwing (used to default Solana recipient at quote time). */
    private resolveSenderOrUndefined;
    private assertExecutionCapability;
    private feeContextFor;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.d.ts.map