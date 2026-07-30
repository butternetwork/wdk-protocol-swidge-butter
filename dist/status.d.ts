import type { ButterSwidgeStatusOptions, EvmTransactionReceipt, SwidgeStatusResult } from './types.js';
/**
 * Maps an on-chain receipt to a SwidgeStatus for same-chain swaps, which do not
 * produce a Butter cross-chain record. A missing receipt means the tx is not
 * yet mined (pending). Mapping is **fail-closed**: only an explicit success maps
 * to `completed` and only an explicit revert to `failed`; any unknown or missing
 * status maps to `pending` rather than falsely reporting completion.
 */
export declare function mapReceiptStatus(id: string, receipt: EvmTransactionReceipt | null | undefined, chain?: string | number): SwidgeStatusResult;
/**
 * Classifies an EVM receipt's status as an explicit `success`, an explicit
 * `reverted`, or `unknown` (missing/unrecognized). Shared by same-chain status
 * mapping and approval-receipt confirmation so both fail closed on `unknown`
 * rather than treating an uninterpretable receipt as success.
 */
export declare function classifyReceiptStatus(receipt: EvmTransactionReceipt | null | undefined): 'success' | 'reverted' | 'unknown';
export declare function mapStatusResponse(id: string, data: unknown, hints?: ButterSwidgeStatusOptions): SwidgeStatusResult;
//# sourceMappingURL=status.d.ts.map