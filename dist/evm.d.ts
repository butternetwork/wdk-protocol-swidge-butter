import type { ButterAccount, ButterRoute, ButterSwapTx, ButterSwidgeProtocolConfig, EvmPublicClient, EvmWalletClient, SwidgeOptions, ViemPublicClientLike, ViemWalletClientLike } from './types.js';
/**
 * Adapts a viem wallet client to the provider's {@link EvmWalletClient}. A raw
 * viem client is not structurally assignable (its `sendTransaction` parameter is
 * strongly typed), so wrap it here. The client must have a bound account; the
 * adapter surfaces that as the required `account.address`.
 */
export declare function toEvmWalletClient(client: ViemWalletClientLike): EvmWalletClient;
/**
 * Adapts a viem public client to the provider's {@link EvmPublicClient}, covering
 * ERC-20 allowance reads, approval-receipt waiting, and the receipt/transaction
 * lookups used for same-chain status and its Router attribution. viem throws a
 * specific not-found error when the tx/receipt is unmined or unknown; this adapter
 * maps ONLY those to `null` (see {@link isViemErrorNamed} for why the check is not
 * a bare `instanceof`). Any other failure (RPC timeout, auth, rate-limit,
 * malformed response) is rethrown so genuine infrastructure faults surface instead
 * of masquerading as "transaction does not exist".
 */
export declare function toEvmPublicClient(client: ViemPublicClientLike): EvmPublicClient;
/** Returns true when the token identifier denotes a chain's native asset. */
export declare function isNativeToken(token: string): boolean;
/**
 * Executes a validated Butter swap transaction (plus ERC-20 approval when needed) on an EVM chain.
 *
 * Up to three transactions can be submitted (`approve(0)`, `approve(amount)`, the
 * swap), so each send is recorded through {@link RecordSend} the instant it
 * returns rather than collected at the end. If anything then fails — a later send,
 * or an approval that cannot be confirmed — the already broadcast hashes travel out
 * on a {@link ButterPartialExecutionError} instead of being discarded with the stack
 * frame; a caller that blindly retried would otherwise re-approve or re-swap on top
 * of transactions already on-chain.
 */
export declare function executeEvmSwap(context: {
    account: ButterAccount | undefined;
    config: ButterSwidgeProtocolConfig;
    sender: string;
    route: ButterRoute;
    swapTx: ButterSwapTx;
    options: SwidgeOptions;
    sourceChainId: string;
    nativeSource: boolean;
}): Promise<{
    transactions: Array<{
        hash: string;
        chain: string | number;
        type: 'approval' | 'source';
    }>;
    gasFee: bigint | undefined;
}>;
//# sourceMappingURL=evm.d.ts.map