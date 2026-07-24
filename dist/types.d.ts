import type { SwidgeFee, SwidgeOptions, SwidgeProtocolConfig, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions, SwidgeTransaction } from '@tetherto/wdk-wallet/protocols';
export type { SwidgeFee, SwidgeOptions, SwidgeProtocolConfig, SwidgeQuote, SwidgeResult, SwidgeStatusResult, SwidgeSupportedChain, SwidgeSupportedToken, SwidgeSupportedTokensOptions, SwidgeTransaction };
/**
 * A Butter quote enriched with the provider-specific route `hash`. Pass it back
 * as `options.routeHash` to {@link ButterSwidgeProtocol.swidge} to pin the exact
 * quoted route instead of allowing an automatic re-quote at execution time.
 */
export type ButterSwidgeQuote = SwidgeQuote & {
    routeHash: string;
};
/** Butter-specific execution options layered on top of the WDK `SwidgeOptions`. */
export interface ButterSwidgeExecutionOptions {
    /** Route hash from a prior {@link ButterSwidgeQuote} to pin the approved quote. */
    routeHash?: string;
}
/** WDK swidge options plus Butter's provider-specific execution fields. */
export type ButterSwidgeOptions = SwidgeOptions & ButterSwidgeExecutionOptions;
/**
 * Structural subset of a WDK wallet account used by the Butter provider.
 *
 * Mirrors `IWalletAccountReadOnly` / `IWalletAccount` from `@tetherto/wdk-wallet`:
 * read-only accounts expose {@link getAddress} and {@link getTransactionReceipt},
 * while full accounts additionally expose {@link sendTransaction}. Execution
 * requires a full account (or an explicit `evm.*` sender override).
 */
export interface ButterAccount {
    /** Returns the account's address (present on every WDK account shape). */
    getAddress: () => Promise<string> | string;
    /** Sends a transaction; present only on full (send-capable) accounts. */
    sendTransaction?: (tx: unknown) => Promise<{
        hash?: string;
        fee?: bigint;
    } | string>;
    /** Returns a transaction's receipt, or null while unconfirmed. */
    getTransactionReceipt?: (hash: string) => Promise<unknown | null>;
}
/** Fetch response subset consumed by the Butter HTTP client. */
export interface ButterFetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}
/** Fetch-compatible function used for dependency injection and testing. */
export type ButterFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
}) => Promise<ButterFetchResponse>;
/** Minimal EVM transaction receipt shape used for success/status checks. */
export interface EvmTransactionReceipt {
    status?: string | number | boolean;
}
/** Read-only EVM client capabilities needed for allowance and receipt checks. */
export interface EvmPublicClient {
    readContract: (args: unknown) => Promise<bigint>;
    waitForTransactionReceipt?: (args: {
        hash: string;
        confirmations?: number;
        timeout?: number;
    }) => Promise<EvmTransactionReceipt>;
    /** Fetches a receipt without waiting; used for same-chain status lookups. */
    getTransactionReceipt?: (hash: string) => Promise<EvmTransactionReceipt | null>;
}
/** EVM wallet client capabilities needed for transaction submission. */
export interface EvmWalletClient {
    account?: {
        address: string;
    };
    sendTransaction: (args: unknown) => Promise<string | {
        hash?: string;
    }>;
}
/** Converts Butter transaction data for a non-viem execution environment. */
export type ButterTransactionAdapter = (swapTx: ButterSwapTx, context: {
    sender: string;
    receiver: string;
    route: ButterRoute;
    options: SwidgeOptions;
}) => unknown;
/** How this instance would execute on a given chain. */
export type ButterChainExecution = 'native' | 'adapter' | 'quote-only';
/**
 * A supported chain enriched with the Butter-specific `execution` mode, so the
 * extra field is visible in the public type rather than only at runtime.
 */
export type ButterSupportedChain = SwidgeSupportedChain & {
    execution: ButterChainExecution;
};
/** Router calldata validator versions implemented by this package. */
export type ButterRouterVersion = 'v3';
/** Allowlisted Butter Router deployment and its validator version. */
export interface ButterRouterDeployment {
    address: `0x${string}`;
    version: ButterRouterVersion;
}
/** Construction and execution configuration for {@link ButterSwidgeProtocol}. */
export interface ButterSwidgeProtocolConfig extends SwidgeProtocolConfig {
    /** Source chain handled by this protocol instance. */
    sourceChainId: string | number;
    /** Butter-issued integration entrance identifier. */
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
    /** Per-chain native token decimals overriding built-in chain defaults. */
    nativeTokenDecimals?: Record<string, number>;
    /** Additional chain IDs requiring Butter's strict 300 bps slippage floor. */
    strictSlippageChainIds?: Array<string | number>;
    /**
     * Per-chain adapters converting Butter `/swap` data for non-EVM execution.
     *
     * Trust boundary note: adapter execution bypasses the Router V3 calldata
     * validation performed on the built-in EVM path. Only the transaction's
     * chain ID and required fields are checked; the adapter is responsible for
     * any deeper validation of the provider-supplied transaction data.
     */
    transactionAdapters?: Record<string, ButterTransactionAdapter>;
    evm?: {
        /**
         * Read-only client for ERC-20 allowance checks. Optional: without it the
         * provider skips the allowance read and always submits an approval.
         */
        publicClient?: EvmPublicClient;
        /** Optional viem-style wallet client overriding account-based sending. */
        walletClient?: EvmWalletClient;
        /** Optional raw sender overriding both the wallet client and the account. */
        sendTransaction?: (tx: EvmTransactionRequest) => Promise<string | {
            hash?: string;
        }>;
        approvalAmount?: 'exact' | 'max';
        approvalConfirmations?: number;
        approvalTimeoutMs?: number;
    };
}
/** Token metadata returned inside a Butter route. */
export interface ButterRouteToken {
    address?: string;
    decimals?: number | string;
    symbol?: string;
    name?: string;
}
/** Per-chain route segment returned by Butter. */
export interface ButterRouteChain {
    chainId?: string | number;
    tokenIn?: ButterRouteToken;
    tokenOut?: ButterRouteToken;
    totalAmountIn?: string;
    totalAmountOut?: string;
    totalAmountInUSD?: string;
    totalAmountOutUSD?: string;
}
/** Normalized shape of a Butter `/route` result. */
export interface ButterRoute {
    hash: string;
    timestamp?: number;
    hasLiquidity?: boolean;
    timeEstimated?: number;
    estimatedTime?: number;
    contract?: string;
    priceImpact?: string | number;
    bridgeFee?: ButterBridgeFee;
    gasFee?: ButterFee;
    swapFee?: {
        nativeFee?: string;
        tokenFee?: string;
        nativeSymbol?: string;
        tokenSymbol?: string;
    };
    /** Integrator/affiliate fee config mirrored into the `/swap` calldata feeData. */
    feeConfig?: ButterFeeConfig;
    minAmountOut?: {
        amount?: string;
        symbol?: string;
    };
    amountOutMin?: string;
    srcChain?: ButterRouteChain;
    bridgeChain?: ButterRouteChain;
    dstChain?: ButterRouteChain;
    totalAmountIn?: string;
    totalAmountOut?: string;
    totalAmountInUSD?: string;
    totalAmountOutUSD?: string;
}
/** Butter `/route` integrator fee configuration, encoded on-chain as `feeData`. */
export interface ButterFeeConfig {
    feeType?: number | string;
    referrer?: string;
    rateOrNativeFee?: string | number;
}
/** Common Butter fee fields. */
export interface ButterFee {
    amount?: string;
    symbol?: string;
    address?: string;
    chainId?: string | number;
    inUSD?: string;
}
/** Token-denominated component of a Butter bridge fee. */
export interface ButterFeePart {
    amount?: string;
    token?: ButterRouteToken;
}
/** Detailed bridge and affiliate fee information. */
export interface ButterBridgeFee extends ButterFee {
    in?: ButterFeePart;
    out?: ButterFeePart;
    affiliate?: ButterFeePart & {
        list?: unknown[];
        data?: string;
    };
}
/** Transaction request returned by Butter `/swap`. */
export interface ButterSwapTx {
    to: string;
    value: string;
    chainId: string | number;
    data?: string | undefined;
    method?: string | undefined;
    args?: unknown[] | undefined;
    memo?: string | undefined;
}
/** Chain metadata returned by Butter discovery APIs. */
export interface ButterChainInfo {
    id?: string | number;
    chainId?: string | number;
    chainType?: string;
    type?: string;
    name?: string;
    key?: string;
    nativeToken?: string | ButterTokenInfo;
}
/** Token metadata returned by Butter discovery APIs. */
export interface ButterTokenInfo {
    chainId?: string | number;
    address?: string;
    token?: string;
    decimals?: number | string;
    decimal?: number | string;
    symbol?: string;
    name?: string;
}
/** EVM transaction request passed to configured senders. */
export interface EvmTransactionRequest {
    to: `0x${string}` | string;
    value?: bigint | undefined;
    data?: `0x${string}` | string | undefined;
    chainId?: number | undefined;
}
/** Internal cached route envelope. */
export interface CachedRoute {
    key: string;
    route: ButterRoute;
    slippageBps: number;
    expiresAt: number;
}
//# sourceMappingURL=types.d.ts.map