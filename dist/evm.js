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
import { ButterApiError, ButterConfigurationError, ButterPartialExecutionError } from './errors.js';
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
 * True when `error` is viem's not-found error of the given class name.
 *
 * `instanceof` alone is not reliable here: the wrapped client is constructed by
 * the host application with ITS copy of viem, which need not be the copy this
 * package resolved (a different version range, or pnpm's isolated layout). Two
 * copies mean two class identities, so a genuine not-found would fail the
 * `instanceof` and be rethrown as if it were an infrastructure fault. viem sets
 * `name` explicitly on each error class and `shortMessage` on its `BaseError`,
 * and both survive the copy boundary — while still rejecting an unrelated error
 * that merely happens to share a name.
 */
function isViemErrorNamed(error, name) {
    if (!(error instanceof Error) || error.name !== name)
        return false;
    return typeof error.shortMessage === 'string';
}
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
                if (isViemErrorNamed(error, 'TransactionReceiptNotFoundError'))
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
                if (isViemErrorNamed(error, 'TransactionNotFoundError'))
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
export async function executeEvmSwap(context) {
    const transactions = [];
    // One entry per submitted transaction; undefined means that send reported no
    // fee. The measured gas fee is only usable when EVERY send reported one — a
    // partial sum would understate the true cost.
    const feeParts = [];
    const record = (sent, type) => {
        // Push before validating the fee: the send returned, so the transaction is
        // already on the wire and must appear in any partial-execution report even
        // when the fee it reported is unusable. A throw below leaves feeParts one
        // entry short, which is harmless — the failure path never reads it.
        transactions.push({ hash: sent.hash, chain: context.sourceChainId, type });
        feeParts.push(assertGasFee(sent.fee));
    };
    let stage = 'approval';
    try {
        if (!context.nativeSource)
            await approveIfNeeded(context, record);
        stage = 'source';
        record(await sendEvmTransaction(context, {
            to: context.swapTx.to,
            value: parseIntegerAmount(context.swapTx.value),
            data: context.swapTx.data,
            chainId: Number(context.sourceChainId)
        }), 'source');
        // Totalled inside the try on purpose: from the first successful send onward
        // every failure is a partial execution, including one raised while summing.
        const allMeasured = feeParts.length > 0 && feeParts.every((fee) => fee != null);
        return {
            transactions,
            gasFee: allMeasured ? feeParts.reduce((total, fee) => total + (fee ?? 0n), 0n) : undefined
        };
    }
    catch (cause) {
        // Nothing broadcast yet (rejected in the wallet, RPC refused, allowance read
        // failed) → not a partial execution; surface the original error unchanged.
        if (transactions.length === 0)
            throw cause;
        throw new ButterPartialExecutionError(transactions, cause, stage);
    }
}
/**
 * Brings the router's allowance to exactly the input amount, reporting each
 * approval through `record` as soon as it is sent. Recording per-send (rather
 * than returning the list) is what lets a failure of the second `approve` still
 * surface the first one's hash.
 */
async function approveIfNeeded(context, record) {
    const publicClient = context.config.evm?.publicClient;
    const amount = context.approvalAmount;
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
            return;
        assertApprovalConfirmable(context);
        // Reset a non-zero allowance to 0 first for tokens (e.g. USDT) that forbid
        // changing a non-zero allowance directly.
        if (allowance > 0n)
            await approveExact(context, 0n, record);
        await approveExact(context, amount, record);
        return;
    }
    // Without an allowance read we cannot detect the current value; a single exact
    // approval overwrites it to the input amount (bounded for standard ERC-20).
    assertApprovalConfirmable(context);
    await approveExact(context, amount, record);
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
async function approveExact(context, value, record) {
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
    // Record before confirming: the approval is already broadcast, so a revert or
    // a confirmation timeout must still surface its hash to the caller.
    record(sent, 'approval');
    await waitForApproval(context, sent.hash);
}
/**
 * Waits for the approval transaction to confirm before submitting the swap.
 *
 * Prefers `publicClient.waitForTransactionReceipt`; falls back to polling the
 * account's `getTransactionReceipt`. One of the two always exists here:
 * {@link assertApprovalConfirmable} runs before the approval is sent, so the
 * final guard below is an unreachable backstop that throws rather than letting
 * an unconfirmed approval through.
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
    // Unreachable: assertApprovalConfirmable already proved a receipt source
    // exists. Kept as a fail-closed backstop — never silently skip confirmation.
    if (!getReceipt) {
        throw new ButterConfigurationError('ERC20 approval was sent with no receipt source to confirm it', { hash });
    }
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
/**
 * Normalizes a sender result to a hash plus whatever fee it reported.
 *
 * Only the hash is validated here. The fee is checked separately, by
 * {@link assertGasFee}, *after* the caller has recorded the transaction — a send
 * that returned has already broadcast, so a bad fee must not erase the hash from
 * a partial-execution report.
 *
 * The hash is the one value that must be validated *before* recording, because
 * the hash IS the record: a sender that returns no usable hash has still
 * broadcast the transaction, but it cannot be identified, so there is nothing to
 * report and this throws.
 */
function normalizeSend(result) {
    if (typeof result === 'string')
        return { hash: assertTransactionHash(result) };
    const hash = assertTransactionHash(result.hash);
    return result.fee != null ? { hash, fee: result.fee } : { hash };
}
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
 */
export function assertTransactionHash(value) {
    if (typeof value !== 'string') {
        throw new ButterConfigurationError('Transaction sender did not return a hash', { hash: String(value), type: typeof value });
    }
    if (value.trim() === '') {
        throw new ButterConfigurationError('Transaction sender returned an empty transaction hash');
    }
    return value;
}
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
 */
export function assertGasFee(fee) {
    if (fee == null)
        return undefined;
    if (typeof fee !== 'bigint') {
        throw new ButterApiError('Transaction sender reported a non-bigint fee', { fee: String(fee), type: typeof fee });
    }
    if (fee < 0n) {
        throw new ButterApiError('Transaction sender reported a negative fee', { fee: fee.toString() });
    }
    return fee;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=evm.js.map