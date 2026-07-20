import type { ButterAccount, ButterRoute, ButterSwapTx, ButterSwidgeProtocolConfig, SwidgeOptions } from './types.js';
export declare function isNativeToken(token: string): boolean;
export declare function executeEvmSwap(context: {
    account: ButterAccount | undefined;
    config: ButterSwidgeProtocolConfig;
    sender: string;
    route: ButterRoute;
    swapTx: ButterSwapTx;
    options: SwidgeOptions;
    sourceChainId: string;
    nativeSource: boolean;
}): Promise<Array<{
    hash: string;
    chain: string | number;
    type: 'approval' | 'source';
}>>;
//# sourceMappingURL=evm.d.ts.map