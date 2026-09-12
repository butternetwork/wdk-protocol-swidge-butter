import type { ButterSwidgeStatusOptions, EvmTransactionReceipt, SwidgeStatusResult } from './types.js';
/**
 * Maps an on-chain receipt to a SwidgeStatus for same-chain swaps, which do not
 * produce a Butter cross-chain record. A missing receipt means the tx is not
 * yet mined (pending). Mapping is **fail-closed**: only an explicit success maps
 * to `completed` and only an explicit revert to `failed`; any unknown or missing
 * status maps to `pending` rather than falsely reporting completion.
 *
 * @param {string} id - The identifier to normalize or query.
 * @param {EvmTransactionReceipt | null | undefined} receipt - The transaction receipt to classify.
 * @param {string | number} [chain] - The chain metadata to inspect.
 * @returns {SwidgeStatusResult} The mapped provider result.
 */
export declare function mapReceiptStatus(id: string, receipt: EvmTransactionReceipt | null | undefined, chain?: string | number): SwidgeStatusResult;
/**
 * Maps the raw WDK Solana receipt, retaining normalized account receipt support.
 *
 * @param {string} id - The recorded source transaction signature.
 * @param {unknown} receipt - The account's raw or normalized transaction receipt.
 * @param {string | number} chain - The source chain identifier.
 * @returns {SwidgeStatusResult} The receipt's terminal state, or pending for unknown metadata.
 */
export declare function mapSolanaReceiptStatus(id: string, receipt: unknown, chain: string | number): SwidgeStatusResult;
/**
 * Classifies an EVM receipt's status as an explicit `success`, an explicit
 * `reverted`, or `unknown` (missing/unrecognized). Shared by same-chain status
 * mapping and approval-receipt confirmation so both fail closed on `unknown`
 * rather than treating an uninterpretable receipt as success.
 *
 * @param {EvmTransactionReceipt | null | undefined} receipt - The transaction receipt to classify.
 * @returns {'success' | 'reverted' | 'unknown'} The explicit success, revert, or unknown classification.
 */
export declare function classifyReceiptStatus(receipt: EvmTransactionReceipt | null | undefined): 'success' | 'reverted' | 'unknown';
/**
 * Maps a raw Tron receipt, giving native outcomes precedence over normalized status.
 *
 * @param {string} id - The recorded source transaction hash.
 * @param {unknown} receipt - The account's raw or normalized transaction receipt.
 * @param {string | number} chain - The source chain identifier.
 * @returns {SwidgeStatusResult} The explicit terminal state, or pending for unknown metadata.
 */
export declare function mapTronReceiptStatus(id: string, receipt: unknown, chain: string | number): SwidgeStatusResult;
/**
 * Maps a partially trusted Butter status response to the WDK status contract.
 *
 * @param {string} id - The identifier to normalize or query.
 * @param {unknown} data - The partially trusted data to inspect.
 * @param {ButterSwidgeStatusOptions} [hints] - The optional source and destination chain hints (default: empty object).
 * @returns {SwidgeStatusResult} The mapped provider result.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
export declare function mapStatusResponse(id: string, data: unknown, hints?: ButterSwidgeStatusOptions): SwidgeStatusResult;
//# sourceMappingURL=status.d.ts.map