// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { encodeFunctionData, erc20Abi, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { NATIVE_TOKEN_ADDRESSES } from './constants.js';
import { parseIntegerAmount } from './amounts.js';
import { ButterApiError, ButterConfigurationError } from './errors.js';
import { classifyReceiptStatus } from './status.js';
/**
 * Adapts a viem wallet client to the provider's {@link EvmWalletClient}. A raw
 * viem client is not structurally assignable (its `sendTransaction` parameter is
 * strongly typed), so wrap it here. The client must have a bound account; the
 * adapter surfaces that as the required `account.address`.
 */
export function toEvmWalletClient(client) {
    const address = client.account?.address;
    if (!address) {
        throw new ButterConfigurationError('toEvmWalletClient requires a viem wallet client with a bound account');
    }
    return {
        account: { address },
        async sendTransaction(args) {
            return client.sendTransaction(args);
        }
    };
}
/**
 * Adapts a viem public client to the provider's {@link EvmPublicClient}, covering
 * ERC-20 allowance reads, approval-receipt waiting, and the receipt/transaction
 * lookups used for same-chain status and its Router attribution. viem throws a
 * specific not-found error when the tx/receipt is unmined or unknown; this adapter
 * maps ONLY those to `null`. Any other failure (RPC timeout, auth, rate-limit,
 * malformed response) is rethrown so genuine infrastructure faults surface instead
 * of masquerading as "transaction does not exist".
 */
export function toEvmPublicClient(client) {
    return {
        async readContract(args) {
            return await client.readContract(args);
        },
        async waitForTransactionReceipt(args) {
            return client.waitForTransactionReceipt(args);
        },
        async getTransactionReceipt(hash) {
            try {
                return await client.getTransactionReceipt({ hash });
            }
            catch (error) {
                if (error instanceof TransactionReceiptNotFoundError)
                    return null;
                throw error;
            }
        },
        async getTransaction(hash) {
            try {
                const tx = await client.getTransaction({ hash });
                const result = {};
                if (tx.input != null)
                    result.input = tx.input;
                if (tx.to != null)
                    result.to = tx.to;
                return result;
            }
            catch (error) {
                if (error instanceof TransactionNotFoundError)
                    return null;
                throw error;
            }
        }
    };
}
const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
/** Returns true when the token identifier denotes a chain's native asset. */
export function isNativeToken(token) {
    return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase());
}
/** Executes a validated Butter swap transaction (plus ERC-20 approval when needed) on an EVM chain. */
export async function executeEvmSwap(context) {
    const transactions = [];
    // One entry per submitted transaction; undefined means that send reported no
    // fee. The measured gas fee is only usable when EVERY send reported one — a
    // partial sum would understate the true cost.
    const feeParts = [];
    if (!context.nativeSource) {
        for (const approval of await maybeApprove(context)) {
            transactions.push({ hash: approval.hash, chain: context.sourceChainId, type: 'approval' });
            feeParts.push(approval.fee);
        }
    }
    const source = await sendEvmTransaction(context, {
        to: context.swapTx.to,
        value: parseIntegerAmount(context.swapTx.value),
        data: context.swapTx.data,
        chainId: Number(context.sourceChainId)
    });
    transactions.push({ hash: source.hash, chain: context.sourceChainId, type: 'source' });
    feeParts.push(source.fee);
    const allMeasured = feeParts.length > 0 && feeParts.every((fee) => fee != null);
    return {
        transactions,
        gasFee: allMeasured ? feeParts.reduce((total, fee) => total + fee, 0n) : undefined
    };
}
async function maybeApprove(context) {
    const publicClient = context.config.evm?.publicClient;
    const amount = sourceAmountForApproval(context.options);
    if (publicClient) {
        const allowance = await publicClient.readContract({
            address: context.options.fromToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [context.sender, context.swapTx.to]
        });
        // Exact allowance already in place → nothing to do. Any other value (larger
        // OR smaller) is set to exactly the input so exposure never exceeds it.
        if (allowance === amount)
            return [];
        assertApprovalConfirmable(context);
        const approvals = [];
        // Reset a non-zero allowance to 0 first for tokens (e.g. USDT) that forbid
        // changing a non-zero allowance directly.
        if (allowance > 0n)
            approvals.push(await approveExact(context, 0n));
        approvals.push(await approveExact(context, amount));
        return approvals;
    }
    // Without an allowance read we cannot detect the current value; a single exact
    // approval overwrites it to the input amount (bounded for standard ERC-20).
    assertApprovalConfirmable(context);
    return [await approveExact(context, amount)];
}
/**
 * Fails closed when an approval would be submitted with no way to confirm it: a
 * fire-and-forget approval could revert (or be unconfirmed) yet the swap would
 * still follow. Requires `publicClient.waitForTransactionReceipt` or the
 * account's `getTransactionReceipt`.
 */
function assertApprovalConfirmable(context) {
    const canConfirm = Boolean(context.config.evm?.publicClient?.waitForTransactionReceipt ||
        context.account?.getTransactionReceipt);
    if (!canConfirm) {
        throw new ButterConfigurationError('ERC20 approval requires a receipt source to confirm before the swap: provide evm.publicClient.waitForTransactionReceipt or a WDK account with getTransactionReceipt');
    }
}
/** Sends an exact `approve(router, value)` and waits for it to confirm. */
async function approveExact(context, value) {
    const sent = await sendEvmTransaction(context, {
        to: context.options.fromToken,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [context.swapTx.to, value]
        }),
        chainId: Number(context.sourceChainId)
    });
    await waitForApproval(context, sent.hash);
    return sent;
}
/**
 * Waits for the approval transaction to confirm before submitting the swap.
 *
 * Prefers `publicClient.waitForTransactionReceipt`; falls back to polling the
 * account's `getTransactionReceipt`. When neither is available the swap is
 * submitted immediately: same-sender nonce ordering still guarantees the
 * approval mines first.
 *
 * Fail-closed: only an explicit success confirms; an explicit revert throws; an
 * unknown/uninterpretable status is treated as not-yet-final (keep polling until
 * timeout) rather than assumed successful.
 */
async function waitForApproval(context, hash) {
    const publicClient = context.config.evm?.publicClient;
    if (publicClient?.waitForTransactionReceipt) {
        const receiptArgs = {
            hash,
            confirmations: context.config.evm?.approvalConfirmations ?? 1
        };
        if (context.config.evm?.approvalTimeoutMs != null) {
            receiptArgs.timeout = context.config.evm.approvalTimeoutMs;
        }
        const kind = classifyReceiptStatus(await publicClient.waitForTransactionReceipt(receiptArgs));
        if (kind === 'reverted')
            throw new ButterConfigurationError('ERC20 approval transaction reverted', { hash });
        if (kind === 'unknown')
            throw new ButterConfigurationError('Could not confirm the ERC20 approval: unrecognized receipt status', { hash });
        return;
    }
    const getReceipt = context.account?.getTransactionReceipt?.bind(context.account);
    if (!getReceipt)
        return;
    const timeoutMs = context.config.evm?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const receipt = await getReceipt(hash);
        if (receipt != null) {
            const kind = classifyReceiptStatus(receipt);
            if (kind === 'success')
                return;
            if (kind === 'reverted')
                throw new ButterConfigurationError('ERC20 approval transaction reverted', { hash });
            // kind === 'unknown': not final yet — keep polling until the deadline.
        }
        await sleep(Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
    throw new ButterConfigurationError('Timed out waiting for the ERC20 approval to confirm', { hash, timeoutMs });
}
function sourceAmountForApproval(options) {
    if ('fromTokenAmount' in options && options.fromTokenAmount != null)
        return BigInt(options.fromTokenAmount);
    throw new ButterConfigurationError('Butter exact-in amount is required for approval');
}
/**
 * Sends an EVM transaction (carrying `data`/`chainId`) via `evm.walletClient`.
 *
 * The WDK account's generic `sendTransaction` is NOT used because the WDK
 * `Transaction` type only guarantees `{ to, value }`, so routing swap/approval
 * calldata through it could silently drop `data`. The wallet client carries a
 * bound `account.address` (validated against the WDK account) so the signer,
 * calldata initiator, and allowance owner cannot split.
 */
async function sendEvmTransaction(context, tx) {
    const walletClient = context.config.evm?.walletClient;
    if (walletClient)
        return normalizeSend(await walletClient.sendTransaction(tx));
    throw new ButterConfigurationError('EVM execution requires evm.walletClient to carry the transaction calldata');
}
/** Normalizes a sender result to a hash plus the gas fee it reported, if any. */
function normalizeSend(result) {
    if (typeof result === 'string')
        return { hash: result };
    if (!result.hash)
        throw new ButterConfigurationError('Transaction sender did not return a hash');
    if (result.fee != null && result.fee < 0n) {
        throw new ButterApiError('Transaction sender reported a negative fee', { fee: result.fee.toString() });
    }
    return result.fee != null ? { hash: result.hash, fee: result.fee } : { hash: result.hash };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=evm.js.map