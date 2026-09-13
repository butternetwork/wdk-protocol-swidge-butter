import { routerDeploymentsForChain, type ButterRouterRegistry } from './router-registry.js';
import type { ButterFeeConfig, ButterRoute, ButterSwapTx } from './types.js';
export interface SwapValidationContext {
    sourceChainId: string;
    destinationChainId: string;
    route: ButterRoute;
    routerRegistry: ButterRouterRegistry;
    nativeSource: boolean;
    requestedAmountIn: bigint;
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
}
/**
 * Validates and normalizes the transaction list returned by Butter swap data.
 *
 * @param {unknown} swapData - The raw transaction data returned by Butter.
 * @param {SwapValidationContext} context - The quoted tokens, chains, amounts, recipients, Router allowlist, and fee bounds.
 * @returns {ButterSwapTx[]} The normalized Butter transactions after complete validation.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 * @throws {ButterTransactionValidationError} If Butter transaction data does not match the requested intent.
 */
export declare function validateSwapTransactions(swapData: unknown, context: SwapValidationContext): ButterSwapTx[];
/**
 * Validates one Butter transaction against the requested source-chain intent.
 *
 * @param {unknown} value - The untrusted `/swap` transaction entry.
 * @param {SwapValidationContext} context - The requested source chain and optional EVM Router validation policy.
 * @returns {ButterSwapTx} The normalized transaction after source-chain validation.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 * @throws {ButterTransactionValidationError} If Butter transaction data does not match the requested intent.
 */
export declare function validateSwapTransaction(value: unknown, context: SwapValidationContext): ButterSwapTx;
/**
 * True when the route's referrer fee config charges a non-zero fee.
 *
 * @param {ButterFeeConfig | undefined} config - The optional route fee tuple whose amount determines whether `feeData` is required.
 * @returns {boolean} Whether the quoted fee configuration encodes a non-zero charge.
 */
export declare function feeConfigChargesFee(config: ButterFeeConfig | undefined): boolean;
/**
 * Returns the Router V3 function a transaction's calldata calls, or undefined if
 * it is not decodable / not a recognized Router function. Used to classify a
 * swidge as same-chain (`swapAndCall`) or cross-chain (`swapAndBridge`).
 *
 * @param {string | undefined} data - The partially trusted data to inspect.
 * @returns {'swapAndCall' | 'swapAndBridge' | undefined} The recognized Router entrypoint, or undefined for invalid calldata.
 */
export declare function routerFunctionName(data: string | undefined): 'swapAndCall' | 'swapAndBridge' | undefined;
/**
 * Resolves a Router address against the effective chain allowlist.
 *
 * @param {string} address - The Router address returned by Butter.
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @returns {ReturnType<typeof routerDeploymentsForChain>[number]} The allowlisted deployment matching the Router address.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 * @throws {ButterTransactionValidationError} If Butter transaction data does not match the requested intent.
 */
export declare function assertRouterAllowed(address: string, chainId: string, registry: ButterRouterRegistry): ReturnType<typeof routerDeploymentsForChain>[number];
/**
 * Lowercases an EVM address for case-insensitive comparison.
 *
 * @param {string} address - The EVM address to normalize.
 * @returns {string} The lowercase EVM address.
 */
export declare function normalizeAddress(address: string): string;
//# sourceMappingURL=swap-data.d.ts.map