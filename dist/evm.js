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
import { APPROVAL_TIMEOUT_MS, NATIVE_TOKEN_ADDRESSES } from './constants.js';
import { parseIntegerAmount } from './amounts.js';
import { ButterApiError, ButterConfigurationError, ButterPartialExecutionError } from './errors.js';
import { classifyReceiptStatus } from './status.js';
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
 *
 * @param {unknown} error - The error value to classify.
 * @param {string} name - The viem error class name to match.
 * @returns {boolean} Whether the error has the requested viem name and BaseError shape.
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
 *
 * @param {ViemPublicClientLike} client - The viem client to adapt.
 * @returns {EvmPublicClient} The provider-compatible EVM public client.
 */
export function toEvmPublicClient(client) {
    return {
        /**
         * Reads contract from the configured client.
         *
         * @param {unknown} args - The request arguments forwarded to the wrapped viem client.
         * @returns {Promise<bigint>} A promise resolving to the integer contract-read result.
         */
        async readContract(args) {
            return await client.readContract(args);
        },
        /**
         * Waits for for transaction receipt.
         *
         * @param {{ hash: string; confirmations?: number; timeout?: number; }} args - The request arguments forwarded to the wrapped viem client.
         * @returns {Promise<EvmTransactionReceipt>} A promise resolving to the confirmed transaction receipt.
         */
        async waitForTransactionReceipt(args) {
            return client.waitForTransactionReceipt(args);
        },
        /**
         * Returns a viem transaction receipt, mapping only genuine not-found errors to null.
         *
         * @param {string} hash - The EVM transaction hash whose receipt is requested.
         * @returns {Promise<EvmTransactionReceipt | null>} The receipt, or null only for a genuine viem not-found response.
         */
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
        /**
         * Returns the transaction fields needed for Router attribution, or null when not found.
         *
         * @param {string} hash - The EVM transaction hash to load for Router attribution.
         * @returns {Promise<EvmTransactionData | null>} The attribution fields, or null when the transaction is not found.
         */
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
const APPROVAL_POLL_INTERVAL_MS = 2_000;
/**
 * Returns true when the token identifier denotes a chain's native asset.
 *
 * @param {string} token - The token identifier to compare against native aliases.
 * @returns {boolean} Whether the identifier is one of the package's native-token aliases.
 */
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
 *
 * @param {ExecuteEvmSwapContext} context - The validated route, sender, swap transaction, and approval bound for one EVM execution.
 * @returns {Promise<ExecuteEvmSwapResult>} The broadcast transactions and sender-reported gas total.
 * @throws {ButterActionRequiredError} If route freshness fails before any transaction was broadcast.
 * @throws {ButterPartialExecutionError} If execution fails after at least one transaction was broadcast.
 */
export async function executeEvmSwap(context) {
    const transactions = [];
    // One entry per submitted transaction; undefined means that send reported no
    // fee. The reported gas fee is only usable when EVERY send reported one — a
    // partial sum would omit part of the sender's estimate.
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
        const allReported = feeParts.length > 0 && feeParts.every((fee) => fee != null);
        return {
            transactions,
            gasFee: allReported ? feeParts.reduce((total, fee) => total + (fee ?? 0n), 0n) : undefined
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
 *
 * @param {ApprovalContext} context - The account, EVM clients, source token, Router, and exact allowance target.
 * @param {RecordSend} record - The callback that records a broadcast transaction.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 * @throws {ButterConfigurationError} If allowance reading or approval confirmation is unavailable, or approval confirmation fails.
 * @throws {Error} If the selected allowance reader or approval sender fails.
 * @throws {ButterActionRequiredError} If the route no longer has sufficient lifetime before an approval send.
 */
async function approveIfNeeded(context, record) {
    const publicClient = context.config.evm?.publicClient;
    const amount = context.approvalAmount;
    let readAllowance;
    if (publicClient) {
        readAllowance = () => publicClient.readContract({
            address: context.options.fromToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [context.sender, context.swapTx.to]
        });
    }
    else if (context.account?.getAllowance) {
        const getAllowance = context.account.getAllowance.bind(context.account);
        readAllowance = () => getAllowance(context.options.fromToken, context.swapTx.to);
    }
    else {
        throw new ButterConfigurationError('ERC20 execution requires an allowance reader: provide evm.publicClient or an account with getAllowance');
    }
    const allowance = await readAllowance();
    // Any different allowance, larger or smaller, is set to the exact input.
    if (allowance === amount)
        return;
    assertApprovalConfirmable(context);
    // USDT-like tokens require a confirmed reset before another non-zero approval.
    if (allowance > 0n)
        await approveExact(context, 0n, record, readAllowance);
    await approveExact(context, amount, record, readAllowance);
}
/**
 * Fails closed when an approval would be submitted with no way to confirm it: a
 * fire-and-forget approval could revert (or be unconfirmed) yet the swap would
 * still follow. Requires `publicClient.waitForTransactionReceipt` or the
 * account's `getTransactionReceipt`. More than one confirmation requires the
 * public-client waiter, since the account contract has no confirmation count.
 *
 * @param {EvmClientContext} context - The configured receipt sources available after an approval broadcast.
 * @returns {void} Returns after confirming that at least one receipt source is configured.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
function assertApprovalConfirmable(context) {
    if ((context.config.evm?.approvalConfirmations ?? 1) > 1 && !context.config.evm?.publicClient?.waitForTransactionReceipt) {
        throw new ButterConfigurationError('Multiple approval confirmations require evm.publicClient.waitForTransactionReceipt');
    }
    const canConfirm = Boolean(context.config.evm?.publicClient?.waitForTransactionReceipt ||
        context.account?.getTransactionReceipt);
    if (!canConfirm) {
        throw new ButterConfigurationError('ERC20 approval requires a receipt source to confirm before the swap: provide evm.publicClient.waitForTransactionReceipt or a WDK account with getTransactionReceipt');
    }
}
/**
 * Sends an exact `approve(router, value)` and verifies its receipt and resulting allowance.
 *
 * @param {ApprovalSendContext} context - The account, EVM client, source token, Router transaction, and source chain.
 * @param {bigint} value - The exact ERC-20 allowance to submit.
 * @param {RecordSend} record - The callback that records a broadcast transaction.
 * @param {() => Promise<bigint>} readAllowance - The fixed allowance reader for this execution.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 * @throws {ButterConfigurationError} If the receipt or resulting allowance cannot be confirmed before the deadline.
 * @throws {Error} If sending, receipt lookup, or allowance lookup fails.
 * @throws {ButterActionRequiredError} If the route no longer has sufficient lifetime before sending.
 */
async function approveExact(context, value, record, readAllowance) {
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
    const timeoutMs = context.config.evm?.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    // Record before confirming: the approval is already broadcast, so a revert or
    // a confirmation timeout must still surface its hash to the caller.
    record(sent, 'approval');
    await waitForApproval(context, sent.hash, deadline);
    let actualAllowance;
    const timedOut = () => new ButterConfigurationError('Timed out waiting for the ERC20 allowance to match the approval', {
        hash: sent.hash,
        token: context.options.fromToken,
        spender: context.swapTx.to,
        expectedAllowance: value.toString(),
        ...(actualAllowance != null ? { actualAllowance: actualAllowance.toString() } : {}),
        timeoutMs
    });
    while (Date.now() < deadline) {
        actualAllowance = await beforeApprovalDeadline(readAllowance, deadline, sent.hash, timeoutMs, timedOut);
        if (Date.now() >= deadline)
            throw timedOut();
        if (actualAllowance === value)
            return;
        await sleep(Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
    throw timedOut();
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
 * A reported transaction hash must identify the original approval. viem can
 * return a successful cancellation or replacement receipt for the same nonce;
 * neither proves the requested approval was mined. Receipts without a hash retain
 * the host contract that the returned status belongs to the queried transaction.
 *
 * @param {EvmClientContext} context - The public client or WDK account used to obtain the approval receipt.
 * @param {string} hash - The approval transaction hash to confirm.
 * @param {number} deadline - The shared receipt and allowance confirmation deadline.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
async function waitForApproval(context, hash, deadline) {
    const timeoutMs = context.config.evm?.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    const publicClient = context.config.evm?.publicClient;
    if (publicClient?.waitForTransactionReceipt) {
        const receiptArgs = {
            hash,
            confirmations: context.config.evm?.approvalConfirmations ?? 1,
            timeout: timeoutMs
        };
        const receipt = await beforeApprovalDeadline(() => publicClient.waitForTransactionReceipt(receiptArgs), deadline, hash, timeoutMs);
        assertApprovalReceiptHash(receipt, hash);
        const kind = classifyReceiptStatus(receipt);
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
    while (Date.now() < deadline) {
        const receipt = await beforeApprovalDeadline(() => getReceipt(hash), deadline, hash, timeoutMs);
        if (receipt != null) {
            assertApprovalReceiptHash(receipt, hash);
            const kind = classifyReceiptStatus(receipt);
            if (kind === 'success')
                return;
            if (kind === 'reverted')
                throw new ButterConfigurationError('ERC20 approval transaction reverted', { hash });
            // kind === 'unknown': not final yet — keep polling until the deadline.
        }
        await sleep(Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
    throw approvalTimeoutError(hash, timeoutMs);
}
/**
 * Verifies a reported receipt hash before its status can confirm an approval.
 *
 * @param {unknown} receipt - The host receipt, optionally carrying a mined transaction hash.
 * @param {string} hash - The submitted approval hash the receipt must identify.
 * @returns {void} Returns when the hash matches or the host omits identity metadata.
 * @throws {ButterConfigurationError} If the receipt reports an invalid or different transaction hash.
 */
function assertApprovalReceiptHash(receipt, hash) {
    if (receipt == null || typeof receipt !== 'object')
        return;
    const record = receipt;
    for (const hashField of ['transactionHash', 'hash']) {
        if (!(hashField in record))
            continue;
        const receiptHash = record[hashField];
        const details = { hash, receiptHash, hashField };
        if (typeof receiptHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receiptHash)) {
            throw new ButterConfigurationError('ERC20 approval receipt has an invalid transaction hash', details);
        }
        if (receiptHash.toLowerCase() !== hash.toLowerCase()) {
            throw new ButterConfigurationError('ERC20 approval receipt belongs to a different transaction', details);
        }
    }
}
/**
 * Runs one approval lookup while enforcing the remaining confirmation deadline.
 *
 * @param {() => Promise<T>} operation - The asynchronous operation constrained by the deadline.
 * @param {number} deadline - The absolute millisecond deadline for the operation.
 * @param {string} hash - The approval transaction hash included in timeout diagnostics.
 * @param {number} timeoutMs - The operation timeout in milliseconds.
 * @param {() => ButterConfigurationError} [timedOut] - The timeout diagnostic for the current confirmation phase.
 * @returns {Promise<T>} The lookup result produced before the deadline.
 * @throws {ButterConfigurationError} If the deadline expires before the lookup completes.
 * @throws {Error} If the lookup fails.
 */
async function beforeApprovalDeadline(operation, deadline, hash, timeoutMs, timedOut = () => approvalTimeoutError(hash, timeoutMs)) {
    const remaining = Math.max(deadline - Date.now(), 0);
    if (remaining === 0)
        throw timedOut();
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(timedOut()), remaining);
            })
        ]);
    }
    finally {
        if (timer != null)
            clearTimeout(timer);
    }
}
/**
 * Creates the configuration error reported when approval confirmation exceeds its deadline.
 *
 * @param {string} hash - The approval transaction hash that exceeded its deadline.
 * @param {number} timeoutMs - The operation timeout in milliseconds.
 * @returns {ButterConfigurationError} The typed approval timeout error.
 */
function approvalTimeoutError(hash, timeoutMs) {
    return new ButterConfigurationError('Timed out waiting for the ERC20 approval to confirm', { hash, timeoutMs });
}
/**
 * Sends an EVM transaction (carrying `data`/`chainId`) via the WDK EVM account.
 *
 * @param {EvmSendContext} context - The WDK account and route freshness guard used to submit calldata.
 * @param {EvmTransactionRequest} tx - The transaction request to validate or send.
 * @returns {Promise<EvmSendResult>} The submitted transaction hash and optional sender-reported fee.
 * @throws {ButterConfigurationError} If a send-capable WDK account is unavailable.
 * @throws {ButterActionRequiredError} If the route no longer has sufficient lifetime.
 */
async function sendEvmTransaction(context, tx) {
    const sendTransaction = context.account?.sendTransaction?.bind(context.account);
    if (!sendTransaction)
        throw new ButterConfigurationError('EVM execution requires a send-capable WDK account');
    context.assertExecutable();
    return normalizeSend(await sendTransaction(tx));
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
 *
 * @param {string | { hash?: string, fee?: bigint }} result - The sender or API result to normalize.
 * @returns {EvmSendResult} The validated transaction hash and optional sender-reported fee.
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
 *
 * @param {unknown} value - The transaction hash returned by a host sender.
 * @returns {string} The validated non-empty transaction hash.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
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
 *
 * @param {unknown} fee - The fee value or metadata to inspect.
 * @returns {bigint | undefined} The validated gas fee, or undefined when no fee was reported.
 * @throws {ButterApiError} If the sender reports a fee that is not a non-negative bigint.
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
/**
 * Waits for the requested delay without blocking the event loop.
 *
 * @param {number} ms - The delay duration in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=evm.js.map