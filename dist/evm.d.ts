import type { ButterAccount, ButterRoute, ButterSwapTx, ButterSwidgeProtocolConfig, EvmPublicClient, EvmWalletClient, SwidgeOptions, ViemPublicClientLike, ViemWalletClientLike } from './types.js';
/**
 * Adapts a viem wallet client to the provider's {@link EvmWalletClient}. The
 * wrapper validates that the client has a bound account and narrows viem's rich
 * transaction surface to the capabilities this provider consumes.
 *
 * @param {ViemWalletClientLike} client - The viem client to adapt.
 * @returns {EvmWalletClient} The provider-compatible EVM wallet client.
 * @throws {ButterConfigurationError} If the viem wallet client has no bound account address.
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
 *
 * @param {ViemPublicClientLike} client - The viem client to adapt.
 * @returns {EvmPublicClient} The provider-compatible EVM public client.
 */
export declare function toEvmPublicClient(client: ViemPublicClientLike): EvmPublicClient;
/**
 * Returns true when the token identifier denotes a chain's native asset.
 *
 * @param {string} token - The token identifier to compare against native aliases.
 * @returns {boolean} Whether the identifier is one of the package's native-token aliases.
 */
export declare function isNativeToken(token: string): boolean;
interface ExecuteEvmSwapContext {
    account: ButterAccount | undefined;
    config: ButterSwidgeProtocolConfig;
    sender: string;
    route: ButterRoute;
    swapTx: ButterSwapTx;
    options: SwidgeOptions;
    sourceChainId: string;
    nativeSource: boolean;
    /**
     * Exact ERC-20 allowance to grant the router, in source-token base units. The
     * caller resolves it from the validated exact-in amount.
     */
    approvalAmount: bigint;
}
interface ExecuteEvmSwapResult {
    transactions: {
        hash: string;
        chain: string | number;
        type: 'approval' | 'source';
    }[];
    gasFee: bigint | undefined;
}
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
 *
 * @param {ExecuteEvmSwapContext} context - The validated route, sender, swap transaction, and approval bound for one EVM execution.
 * @returns {Promise<ExecuteEvmSwapResult>} The broadcast transactions and measured gas total.
 * @throws {ButterPartialExecutionError} If execution fails after at least one transaction was broadcast.
 */
export declare function executeEvmSwap(context: ExecuteEvmSwapContext): Promise<ExecuteEvmSwapResult>;
/**
 * Validates a transaction hash reported by a host-supplied sender.
 *
 * Same reasoning as {@link assertGasFee}: the wallet client and transaction
 * adapters are implemented by the host application, which may be plain
 * JavaScript, so the declared `string` is not a runtime guarantee. An unvalidated
 * hash propagates far — into the recorded transaction list, the operation id, the
 * status-routing key (`toLowerCase()`), and approval receipt lookups — where a
 * number surfaces as a raw `TypeError` and an empty string silently produces an
 * unusable `id: ''`.
 *
 * @param {unknown} value - The transaction hash returned by a host sender.
 * @returns {string} The validated non-empty transaction hash.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
export declare function assertTransactionHash(value: unknown): string;
/**
 * Validates a gas fee reported by a host-supplied sender.
 *
 * The declared `bigint` is not a runtime guarantee — the wallet client is
 * implemented by the host application, which may be plain JavaScript. A `number`
 * would slip past a bare `< 0n` test (JS allows mixed relational operands, so
 * `1 < 0n` is simply false) and then poison the bigint total with a raw
 * `TypeError`, so anything that is not a non-negative bigint is rejected here.
 *
 * Call this only once the transaction has been recorded: it is broadcast either
 * way, and its hash matters more than its fee.
 *
 * @param {unknown} fee - The fee value or metadata to inspect.
 * @returns {bigint | undefined} The validated gas fee, or undefined when no fee was reported.
 * @throws {ButterApiError} If the sender reports a fee that is not a non-negative bigint.
 */
export declare function assertGasFee(fee: unknown): bigint | undefined;
export {};
//# sourceMappingURL=evm.d.ts.map