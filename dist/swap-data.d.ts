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
    /**
     * Refund destination the caller explicitly asked for, if any. When set, the
     * address Butter actually encoded is verified against it; when unset, Butter's
     * own default is trusted and the nested payload is not decoded at all.
     */
    refundAddress?: string;
    requireRouterAllowlist: boolean;
    /** Router protocol native fee (route.swapFee.nativeFee), distinct from the bridge fee. */
    routerNativeFee?: bigint;
    /** Integrator fee config from `/route`; the calldata `feeData` must match it. */
    feeConfig?: ButterFeeConfig;
    /** Absolute cap (native base units) on routerNativeFee + bridgeNativeFee; required cross-chain. */
    maxNativeFee?: bigint;
    /**
     * Exact-out only: upper bound on the calldata's source amount, from the caller's
     * `maxFromTokenAmount`. Mutually exclusive with {@link requestedAmountIn}, which
     * demands exact equality; see `assertSourceAmountIn`.
     */
    maxAmountIn?: bigint;
}
export declare function validateSwapTransactions(swapData: unknown, context: SwapValidationContext): ButterSwapTx[];
export declare function validateSwapTransaction(value: unknown, context: SwapValidationContext): ButterSwapTx;
/** True when the route's referrer fee config charges a non-zero fee. */
export declare function feeConfigChargesFee(config: ButterFeeConfig | undefined): boolean;
/**
 * Returns the Router V3 function a transaction's calldata calls, or undefined if
 * it is not decodable / not a recognized Router function. Used to classify a
 * swidge as same-chain (`swapAndCall`) or cross-chain (`swapAndBridge`).
 */
export declare function routerFunctionName(data: string | undefined): 'swapAndCall' | 'swapAndBridge' | undefined;
export declare function assertRouterAllowed(address: string, chainId: string, registry: ButterRouterRegistry): ReturnType<typeof routerDeploymentsForChain>[number];
export declare function normalizeAddress(address: string): string;
//# sourceMappingURL=swap-data.d.ts.map