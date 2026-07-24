import { routerDeploymentsForChain, type ButterRouterRegistry } from './router-registry.js';
import type { ButterFeeConfig, ButterRoute, ButterSwapTx } from './types.js';
export interface SwapValidationContext {
    sourceChainId: string;
    destinationChainId: string;
    route: ButterRoute;
    routerRegistry: ButterRouterRegistry;
    nativeSource: boolean;
    requestedAmountIn?: bigint;
    minimumAmountOut?: bigint;
    sender: string;
    receiver: string;
    sourceToken: string;
    destinationToken: string;
    requireRouterAllowlist: boolean;
    /** Router protocol native fee (route.swapFee.nativeFee), distinct from the bridge fee. */
    routerNativeFee?: bigint;
    /** Integrator fee config from `/route`; the calldata `feeData` must match it. */
    feeConfig?: ButterFeeConfig;
}
export declare function validateSwapTransactions(swapData: unknown, context: SwapValidationContext): ButterSwapTx[];
export declare function validateSwapTransaction(value: unknown, context: SwapValidationContext): ButterSwapTx;
export declare function assertRouterAllowed(address: string, chainId: string, registry: ButterRouterRegistry): ReturnType<typeof routerDeploymentsForChain>[number];
export declare function normalizeAddress(address: string): string;
//# sourceMappingURL=swap-data.d.ts.map