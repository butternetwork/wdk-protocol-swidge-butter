import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
import type { ButterAccount, ButterSwidgeProtocolConfig, SwidgeOptions, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions } from './types.js';
export declare class ButterSwidgeProtocol extends SwidgeProtocol {
    private readonly account;
    private readonly config;
    private readonly http;
    private readonly routes;
    private readonly discovery;
    private readonly now;
    private readonly sourceChainId;
    private readonly routerRegistry;
    constructor(account: ButterAccount | undefined, config: ButterSwidgeProtocolConfig);
    quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote>;
    swidge(options: SwidgeOptions): Promise<SwidgeResult>;
    getSwidgeStatus(id: string, options?: {
        byOrderId?: boolean;
        fromChain?: string | number;
        toChain?: string | number;
    }): Promise<SwidgeStatusResult>;
    getSupportedChains(): Promise<SwidgeSupportedChain[]>;
    getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
    private assertQuoteOptions;
    private assertExecutionSupportForQuote;
    private isBuiltInEvmExecution;
    private getSender;
}
export default ButterSwidgeProtocol;
//# sourceMappingURL=protocol.d.ts.map