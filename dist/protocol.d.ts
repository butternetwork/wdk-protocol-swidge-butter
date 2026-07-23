import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
import type { ButterAccount, ButterSwidgeProtocolConfig, SwidgeOptions, SwidgeProtocolConfig, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions } from './types.js';
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
    /** Returns a non-binding exact-in quote without requiring execution capability. */
    quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote>;
    /** Executes an exact-in operation after validating route fees and transaction intent. */
    swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>;
    /** Retrieves a Butter operation by source hash or, when requested, order ID. */
    getSwidgeStatus(id: string, options?: {
        byOrderId?: boolean;
        fromChain?: string | number;
        toChain?: string | number;
    }): Promise<SwidgeStatusResult>;
    /** Lists chains currently advertised by Butter Router. */
    getSupportedChains(): Promise<SwidgeSupportedChain[]>;
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
    private assertExecutionCapability;
    private feeContextFor;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.d.ts.map