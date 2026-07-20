import type { ButterChainInfo, ButterRoute, ButterTokenInfo, SwidgeFee, SwidgeQuote, SwidgeSupportedChain, SwidgeSupportedToken } from './types.js';
export declare function routeToQuote(route: ButterRoute, now: () => number, expiry?: number): SwidgeQuote;
export declare function routeFees(route: ButterRoute): SwidgeFee[];
export declare function chainToSupportedChain(chain: ButterChainInfo, execution: string): SwidgeSupportedChain & {
    execution: string;
};
export declare function tokenToSupportedToken(token: ButterTokenInfo, chainId: string): SwidgeSupportedToken;
export declare function parseJsonMaybe<T>(value: unknown): T | undefined;
export declare function normalizeId(id: string | number | undefined): string;
//# sourceMappingURL=mappers.d.ts.map