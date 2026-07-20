import type { SwidgeFee, SwidgeOptions, SwidgeProtocolConfig, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions } from '@tetherto/wdk-wallet/protocols';
export type { SwidgeFee, SwidgeOptions, SwidgeProtocolConfig, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions };
export interface ButterAccount {
    getAddress?: () => Promise<string> | string;
    address?: string;
    sendTransaction?: (tx: unknown) => Promise<{
        hash?: string;
    } | string>;
}
export interface ButterFetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}
export type ButterFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
}) => Promise<ButterFetchResponse>;
export interface EvmPublicClient {
    readContract: (args: unknown) => Promise<bigint>;
    waitForTransactionReceipt?: (args: {
        hash: string;
        confirmations?: number;
        timeout?: number;
    }) => Promise<unknown>;
}
export interface EvmWalletClient {
    account?: {
        address: string;
    };
    sendTransaction: (args: unknown) => Promise<string | {
        hash?: string;
    }>;
}
export type ButterTransactionAdapter = (swapTx: ButterSwapTx, context: {
    sender: string;
    receiver: string;
    route: ButterRoute;
    options: SwidgeOptions;
}) => unknown;
export type ButterRouterVersion = 'v3';
export interface ButterRouterDeployment {
    address: `0x${string}`;
    version: ButterRouterVersion;
}
export interface ButterSwidgeProtocolConfig extends SwidgeProtocolConfig {
    sourceChainId: string | number;
    entrance: string;
    apiKeyId?: string | undefined;
    apiSecret?: string | undefined;
    authMode?: 'required' | 'optional';
    routerBaseUrl?: string;
    tokenBaseUrl?: string;
    appBaseUrl?: string;
    fetch?: ButterFetch;
    now?: () => number;
    routerContracts?: Partial<Record<number, readonly ButterRouterDeployment[]>>;
    tokenDecimals?: Record<string, number>;
    transactionAdapters?: Record<string, ButterTransactionAdapter>;
    exposeQuoteOnlyChains?: boolean;
    evm?: {
        publicClient?: EvmPublicClient;
        walletClient?: EvmWalletClient;
        sendTransaction?: (tx: EvmTransactionRequest) => Promise<string | {
            hash?: string;
        }>;
        approvalAmount?: 'exact' | 'max';
        approvalConfirmations?: number;
        approvalTimeoutMs?: number;
        useAccountTransaction?: boolean;
    };
}
export interface ButterRouteToken {
    address?: string;
    decimals?: number | string;
    symbol?: string;
    name?: string;
}
export interface ButterRouteChain {
    chainId?: string | number;
    tokenIn?: ButterRouteToken;
    tokenOut?: ButterRouteToken;
    totalAmountIn?: string;
    totalAmountOut?: string;
}
export interface ButterRoute {
    hash: string;
    timestamp?: number;
    hasLiquidity?: boolean;
    timeEstimated?: number;
    estimatedTime?: number;
    contract?: string;
    priceImpact?: string | number;
    bridgeFee?: ButterFee;
    gasFee?: ButterFee;
    swapFee?: {
        nativeFee?: string;
        tokenFee?: string;
        nativeSymbol?: string;
        tokenSymbol?: string;
    };
    minAmountOut?: {
        amount?: string;
        symbol?: string;
    };
    amountOutMin?: string;
    srcChain?: ButterRouteChain;
    dstChain?: ButterRouteChain;
    totalAmountIn?: string;
    totalAmountOut?: string;
}
export interface ButterFee {
    amount?: string;
    symbol?: string;
    address?: string;
    chainId?: string | number;
}
export interface ButterSwapTx {
    to: string;
    value: string;
    chainId: string | number;
    data?: string | undefined;
    method?: string | undefined;
    args?: unknown[] | undefined;
    memo?: string | undefined;
}
export interface ButterChainInfo {
    id?: string | number;
    chainId?: string | number;
    chainType?: string;
    type?: string;
    name?: string;
    key?: string;
    nativeToken?: string | ButterTokenInfo;
}
export interface ButterTokenInfo {
    chainId?: string | number;
    address?: string;
    token?: string;
    decimals?: number | string;
    decimal?: number | string;
    symbol?: string;
    name?: string;
}
export interface EvmTransactionRequest {
    to: `0x${string}` | string;
    value?: bigint | undefined;
    data?: `0x${string}` | string | undefined;
    chainId?: number | undefined;
}
export interface CachedRoute {
    key: string;
    route: ButterRoute;
    slippageBps: number;
    expiresAt: number;
}
//# sourceMappingURL=types.d.ts.map