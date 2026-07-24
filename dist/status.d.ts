import type { EvmTransactionReceipt, SwidgeStatusResult } from './types.js';
/**
 * Maps an on-chain receipt to a SwidgeStatus for same-chain swaps, which do not
 * produce a Butter cross-chain record. A missing receipt means the tx is not
 * yet mined (pending); a reverted receipt is a terminal failure.
 */
export declare function mapReceiptStatus(id: string, receipt: EvmTransactionReceipt | null | undefined, chain?: string | number): SwidgeStatusResult;
export declare function mapStatusResponse(id: string, data: unknown, hints?: {
    fromChain?: string | number;
    toChain?: string | number;
    byOrderId?: boolean;
}): SwidgeStatusResult;
//# sourceMappingURL=status.d.ts.map