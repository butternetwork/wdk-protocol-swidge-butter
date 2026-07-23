import { type FeeContext } from './fees.js';
import type { ButterChainExecution, ButterChainInfo, ButterRoute, ButterSupportedChain, ButterTokenInfo, SwidgeQuote, SwidgeSupportedToken } from './types.js';
/**
 * Builds a WDK quote from a Butter route.
 *
 * For exact-in the caller passes `requestedAmountIn` (the base-unit input the
 * user asked for); the quote echoes it verbatim so `fromTokenAmount` can never
 * drift from the request due to a decimals-source mismatch. Output amounts use
 * the route-echoed destination decimals, which must be present.
 */
export declare function routeToQuote(route: ButterRoute, now: () => number, expiry: number | undefined, feeContext: FeeContext, requestedAmountIn?: number | bigint): SwidgeQuote;
export declare function chainToSupportedChain(chain: ButterChainInfo, execution: ButterChainExecution): ButterSupportedChain;
export declare function tokenToSupportedToken(token: ButterTokenInfo, chainId: string): SwidgeSupportedToken;
export declare function parseJsonMaybe<T>(value: unknown): T | undefined;
export declare function normalizeId(id: string | number | undefined): string;
//# sourceMappingURL=mappers.d.ts.map