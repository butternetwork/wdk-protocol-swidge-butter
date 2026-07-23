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
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { NATIVE_TOKEN_ADDRESSES } from './constants.js';
import { parseIntegerAmount } from './amounts.js';
import { ButterConfigurationError } from './errors.js';
const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
/** Returns true when the token identifier denotes a chain's native asset. */
export function isNativeToken(token) {
    return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase());
}
/** Executes a validated Butter swap transaction (plus ERC-20 approval when needed) on an EVM chain. */
export async function executeEvmSwap(context) {
    const transactions = [];
    if (!context.nativeSource) {
        const approvalHash = await maybeApprove(context);
        if (approvalHash) {
            transactions.push({ hash: approvalHash, chain: context.sourceChainId, type: 'approval' });
        }
    }
    const sourceHash = await sendEvmTransaction(context, {
        to: context.swapTx.to,
        value: parseIntegerAmount(context.swapTx.value),
        data: context.swapTx.data,
        chainId: Number(context.sourceChainId)
    });
    transactions.push({ hash: sourceHash, chain: context.sourceChainId, type: 'source' });
    return transactions;
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
        if (allowance >= amount)
            return undefined;
    }
    const approvalAmount = context.config.evm?.approvalAmount === 'max' ? maxUint256 : amount;
    const hash = await sendEvmTransaction(context, {
        to: context.options.fromToken,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [context.swapTx.to, approvalAmount]
        }),
        chainId: Number(context.sourceChainId)
    });
    await waitForApproval(context, hash);
    return hash;
}
/**
 * Waits for the approval transaction to confirm before submitting the swap.
 *
 * Prefers `publicClient.waitForTransactionReceipt`; falls back to polling the
 * account's `getTransactionReceipt`. When neither is available the swap is
 * submitted immediately: same-sender nonce ordering still guarantees the
 * approval mines first.
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
        await publicClient.waitForTransactionReceipt(receiptArgs);
        return;
    }
    const getReceipt = context.account?.getTransactionReceipt?.bind(context.account);
    if (!getReceipt)
        return;
    const timeoutMs = context.config.evm?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await getReceipt(hash) != null)
            return;
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
 * Sends an EVM transaction using the first available sender.
 *
 * Explicit overrides (`evm.sendTransaction`, then `evm.walletClient`) take
 * precedence; otherwise the WDK account's own `sendTransaction` is used, so a
 * plain WDK account works with no viem configuration.
 */
async function sendEvmTransaction(context, tx) {
    const sender = context.config.evm?.sendTransaction;
    const walletClient = context.config.evm?.walletClient;
    if (sender)
        return hashOf(await sender(tx));
    if (walletClient)
        return hashOf(await walletClient.sendTransaction(tx));
    if (context.account?.sendTransaction) {
        return hashOf(await context.account.sendTransaction(tx));
    }
    throw new ButterConfigurationError('EVM execution requires a send-capable account, evm.walletClient, or evm.sendTransaction');
}
function hashOf(result) {
    if (typeof result === 'string')
        return result;
    if (result.hash)
        return result.hash;
    throw new ButterConfigurationError('Transaction sender did not return a hash');
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=evm.js.map