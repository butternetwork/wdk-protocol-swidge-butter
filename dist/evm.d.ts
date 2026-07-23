import type { ButterAccount, ButterRoute, ButterSwapTx, ButterSwidgeProtocolConfig, SwidgeOptions } from './types.js';
/** Returns true when the token identifier denotes a chain's native asset. */
export declare function isNativeToken(token: string): boolean;
/** Executes a validated Butter swap transaction (plus ERC-20 approval when needed) on an EVM chain. */
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