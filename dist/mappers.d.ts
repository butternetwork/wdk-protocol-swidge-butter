import { type FeeContext } from './fees.js';
import type { ButterChainExecution, ButterChainInfo, ButterRoute, ButterSupportedChain, ButterTokenInfo, SwidgeQuote, SwidgeSupportedToken } from './types.js';
/**
 * Builds a WDK quote from a Butter route.
 *
 * For exact-in the caller passes `requestedAmountIn` (the base-unit input the
 * user asked for); the quote echoes it verbatim so `fromTokenAmount` can never
 * drift from the request due to a decimals-source mismatch. Output amounts use
 * the route-echoed destination decimals, which must be present.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {() => number} now - The current Unix timestamp in seconds.
 * @param {number | undefined} expiry - The route expiry timestamp when already resolved.
 * @param {FeeContext} feeContext - The trusted chain, token, and decimals context used for fee mapping.
 * @param {number | bigint} [requestedAmountIn] - The caller-requested source amount in base units.
 * @returns {SwidgeQuote} The normalized WDK quote.
 */
export declare function routeToQuote(route: ButterRoute, now: () => number, expiry: number | undefined, feeContext: FeeContext, requestedAmountIn?: number | bigint): SwidgeQuote;
/**
 * Maps Butter chain metadata to the WDK supported-chain contract.
 *
 * @param {ButterChainInfo} chain - The chain metadata to inspect.
 * @param {ButterChainExecution} execution - The execution capability assigned to the chain.
 * @returns {ButterSupportedChain} The normalized WDK supported-chain descriptor.
 */
export declare function chainToSupportedChain(chain: ButterChainInfo, execution: ButterChainExecution): ButterSupportedChain;
/**
 * Maps Butter token metadata to the WDK supported-token contract.
 *
 * @param {ButterTokenInfo} token - The Butter token metadata to map.
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @returns {SwidgeSupportedToken} The normalized WDK supported-token descriptor.
 */
export declare function tokenToSupportedToken(token: ButterTokenInfo, chainId: string): SwidgeSupportedToken;
/**
 * Parses a possibly JSON-encoded Butter metadata field.
 *
 * @param {unknown} value - The direct value or JSON string to decode.
 * @returns {T | undefined} The decoded value, or undefined for malformed JSON.
 */
export declare function parseJsonMaybe<T>(value: unknown): T | undefined;
/**
 * Converts an optional Butter identifier to a string.
 *
 * @param {string | number | undefined} id - The identifier to normalize or query.
 * @returns {string} The identifier converted to a string, or an empty string when absent.
 */
export declare function normalizeId(id: string | number | undefined): string;
//# sourceMappingURL=mappers.d.ts.map