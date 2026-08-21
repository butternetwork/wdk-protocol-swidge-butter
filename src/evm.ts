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

import { encodeFunctionData, erc20Abi, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
import { APPROVAL_TIMEOUT_MS, NATIVE_TOKEN_ADDRESSES } from './constants.js'
import { parseIntegerAmount } from './amounts.js'
import { ButterApiError, ButterConfigurationError, ButterPartialExecutionError } from './errors.js'
import { classifyReceiptStatus } from './status.js'
import type { ButterAccount, ButterRoute, ButterSwapTx, ButterSwidgeProtocolConfig, EvmPublicClient, EvmTransactionData, EvmTransactionReceipt, EvmTransactionRequest, EvmWalletClient, SwidgeOptions, ViemPublicClientLike, ViemWalletClientLike } from './types.js'

/**
 * Adapts a viem wallet client to the provider's {@link EvmWalletClient}. A raw
 * viem client is not structurally assignable (its `sendTransaction` parameter is
 * strongly typed), so wrap it here. The client must have a bound account; the
 * adapter surfaces that as the required `account.address`.
 *
 * @param {ViemWalletClientLike} client - The viem client to adapt.
 * @returns {EvmWalletClient} The provider-compatible EVM wallet client.
 * @throws {ButterConfigurationError} If the viem wallet client has no bound account address.
 */
export function toEvmWalletClient (client: ViemWalletClientLike): EvmWalletClient {
  const address = client.account?.address
  if (!address) {
    throw new ButterConfigurationError('toEvmWalletClient requires a viem wallet client with a bound account')
  }
  return {
    account: { address },
    /**
     * Sends transaction through the configured sender.
     *
     * @param {unknown} args - The request arguments forwarded to the wrapped viem client.
     * @returns {Promise<`0x${string}`>} A promise resolving to the submitted transaction hash.
     */
    async sendTransaction (args) {
      return client.sendTransaction(args)
    }
  }
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
 *
 * @param {unknown} error - The error value to classify.
 * @param {string} name - The viem error class name to match.
 * @returns {boolean} Whether the inspected values satisfy the condition.
 */
function isViemErrorNamed (error: unknown, name: string): boolean {
  if (!(error instanceof Error) || error.name !== name) return false
  return typeof (error as { shortMessage?: unknown }).shortMessage === 'string'
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
export function toEvmPublicClient (client: ViemPublicClientLike): EvmPublicClient {
  return {
    /**
     * Reads contract from the configured client.
     *
     * @param {unknown} args - The request arguments forwarded to the wrapped viem client.
     * @returns {Promise<bigint>} A promise resolving to the integer contract-read result.
     */
    async readContract (args) {
      return await client.readContract(args) as bigint
    },
    /**
     * Waits for for transaction receipt.
     *
     * @param {{ hash: string; confirmations?: number; timeout?: number; }} args - The request arguments forwarded to the wrapped viem client.
     * @returns {Promise<EvmTransactionReceipt>} A promise resolving to the confirmed transaction receipt.
     */
    async waitForTransactionReceipt (args) {
      return client.waitForTransactionReceipt(args)
    },
    /**
     * Returns a viem transaction receipt, mapping only genuine not-found errors to null.
     *
     * @param {string} hash - The transaction or route hash to process.
     * @returns {Promise<EvmTransactionReceipt | null>} The resolved result.
     */
    async getTransactionReceipt (hash) {
      try {
        return await client.getTransactionReceipt({ hash })
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        if (isViemErrorNamed(error, 'TransactionReceiptNotFoundError')) return null
        throw error
      }
    },
    /**
     * Returns the transaction fields needed for Router attribution, or null when not found.
     *
     * @param {string} hash - The transaction or route hash to process.
     * @returns {Promise<EvmTransactionData | null>} The attribution fields, or null when the transaction is not found.
     */
    async getTransaction (hash) {
      try {
        const tx = await client.getTransaction({ hash })
        const result: EvmTransactionData = {}
        if (tx.input != null) result.input = tx.input
        if (tx.to != null) result.to = tx.to
        return result
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return null
        if (isViemErrorNamed(error, 'TransactionNotFoundError')) return null
        throw error
      }
    }
  }
}

const APPROVAL_POLL_INTERVAL_MS = 2_000

/**
 * Returns true when the token identifier denotes a chain's native asset.
 *
 * @param {string} token - The token identifier or metadata to process.
 * @returns {boolean} Whether the inspected values satisfy the condition.
 */
export function isNativeToken (token: string): boolean {
  return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase())
}

/** Records one submitted transaction the moment its send returns. */
type RecordSend = (sent: { hash: string, fee?: bigint }, type: 'approval' | 'source') => void

interface EvmSendResult {
  hash: string
  fee?: bigint
}

interface ExecuteEvmSwapContext {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
  sender: string
  route: ButterRoute
  swapTx: ButterSwapTx
  options: SwidgeOptions
  sourceChainId: string
  nativeSource: boolean
  /**
   * Exact ERC-20 allowance to grant the router, in source-token base units. The
   * caller resolves it because exact-out has no `fromTokenAmount` to read - it is
   * the caller's `maxFromTokenAmount` bound there, and the exact input for exact-in.
   */
  approvalAmount: bigint
}

interface ExecuteEvmSwapResult {
  transactions: { hash: string, chain: string | number, type: 'approval' | 'source' }[]
  gasFee: bigint | undefined
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
 * @param {ExecuteEvmSwapContext} context - The validated context required by the operation.
 * @returns {Promise<ExecuteEvmSwapResult>} The broadcast transactions and measured gas total.
 * @throws {ButterPartialExecutionError} If execution fails after at least one transaction was broadcast.
 */
export async function executeEvmSwap (context: ExecuteEvmSwapContext): Promise<ExecuteEvmSwapResult> {
  const transactions: { hash: string, chain: string | number, type: 'approval' | 'source' }[] = []
  // One entry per submitted transaction; undefined means that send reported no
  // fee. The measured gas fee is only usable when EVERY send reported one — a
  // partial sum would understate the true cost.
  const feeParts: (bigint | undefined)[] = []
  const record: RecordSend = (sent, type) => {
    // Push before validating the fee: the send returned, so the transaction is
    // already on the wire and must appear in any partial-execution report even
    // when the fee it reported is unusable. A throw below leaves feeParts one
    // entry short, which is harmless — the failure path never reads it.
    transactions.push({ hash: sent.hash, chain: context.sourceChainId, type })
    feeParts.push(assertGasFee(sent.fee))
  }
  let stage: 'approval' | 'source' = 'approval'
  try {
    if (!context.nativeSource) await approveIfNeeded(context, record)
    stage = 'source'
    record(await sendEvmTransaction(context, {
      to: context.swapTx.to,
      value: parseIntegerAmount(context.swapTx.value),
      data: context.swapTx.data,
      chainId: Number(context.sourceChainId)
    }), 'source')
    // Totalled inside the try on purpose: from the first successful send onward
    // every failure is a partial execution, including one raised while summing.
    const allMeasured = feeParts.length > 0 && feeParts.every((fee) => fee != null)
    return {
      transactions,
      gasFee: allMeasured ? feeParts.reduce((total, fee) => total + (fee ?? 0n), 0n) : undefined
    }
  } catch (cause) {
    // Nothing broadcast yet (rejected in the wallet, RPC refused, allowance read
    // failed) → not a partial execution; surface the original error unchanged.
    if (transactions.length === 0) throw cause
    throw new ButterPartialExecutionError(transactions, cause, stage)
  }
}

/**
 * Brings the router's allowance to exactly the input amount, reporting each
 * approval through `record` as soon as it is sent. Recording per-send (rather
 * than returning the list) is what lets a failure of the second `approve` still
 * surface the first one's hash.
 *
 * @param {{ account: ButterAccount | undefined config: ButterSwidgeProtocolConfig sender: string route: ButterRoute swapTx: ButterSwapTx options: SwidgeOptions sourceChainId: string approvalAmount: bigint }} context - The validated context required by the operation.
 * @param {RecordSend} record - The callback that records a broadcast transaction.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 */
async function approveIfNeeded (context: {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
  sender: string
  route: ButterRoute
  swapTx: ButterSwapTx
  options: SwidgeOptions
  sourceChainId: string
  approvalAmount: bigint
}, record: RecordSend): Promise<void> {
  const publicClient = context.config.evm?.publicClient
  const amount = context.approvalAmount
  if (publicClient) {
    const allowance = await publicClient.readContract({
      address: context.options.fromToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [context.sender, context.swapTx.to]
    })
    // Exact allowance already in place → nothing to do. Any other value (larger
    // OR smaller) is set to exactly the input so exposure never exceeds it.
    if (allowance === amount) return
    assertApprovalConfirmable(context)
    // Reset a non-zero allowance to 0 first for tokens (e.g. USDT) that forbid
    // changing a non-zero allowance directly.
    if (allowance > 0n) await approveExact(context, 0n, record)
    await approveExact(context, amount, record)
    return
  }
  // Without an allowance read we cannot detect the current value; a single exact
  // approval overwrites it to the input amount (bounded for standard ERC-20).
  assertApprovalConfirmable(context)
  await approveExact(context, amount, record)
}

/**
 * Fails closed when an approval would be submitted with no way to confirm it: a
 * fire-and-forget approval could revert (or be unconfirmed) yet the swap would
 * still follow. Requires `publicClient.waitForTransactionReceipt` or the
 * account's `getTransactionReceipt`.
 *
 * @param {{ account: ButterAccount | undefined config: ButterSwidgeProtocolConfig }} context - The validated context required by the operation.
 * @returns {void} Nothing; the function throws when validation fails.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
function assertApprovalConfirmable (context: {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
}): void {
  const canConfirm = Boolean(
    context.config.evm?.publicClient?.waitForTransactionReceipt ||
    context.account?.getTransactionReceipt
  )
  if (!canConfirm) {
    throw new ButterConfigurationError(
      'ERC20 approval requires a receipt source to confirm before the swap: provide evm.publicClient.waitForTransactionReceipt or a WDK account with getTransactionReceipt'
    )
  }
}

/**
 * Sends an exact `approve(router, value)` and waits for it to confirm.
 *
 * @param {{ account: ButterAccount | undefined config: ButterSwidgeProtocolConfig swapTx: ButterSwapTx options: SwidgeOptions sourceChainId: string }} context - The validated context required by the operation.
 * @param {bigint} value - The value to parse, normalize, or validate.
 * @param {RecordSend} record - The callback that records a broadcast transaction.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 */
async function approveExact (context: {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
  swapTx: ButterSwapTx
  options: SwidgeOptions
  sourceChainId: string
}, value: bigint, record: RecordSend): Promise<void> {
  const sent = await sendEvmTransaction(context, {
    to: context.options.fromToken,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [context.swapTx.to as `0x${string}`, value]
    }),
    chainId: Number(context.sourceChainId)
  })
  // Record before confirming: the approval is already broadcast, so a revert or
  // a confirmation timeout must still surface its hash to the caller.
  record(sent, 'approval')
  await waitForApproval(context, sent.hash)
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
 *
 * @param {{ account: ButterAccount | undefined config: ButterSwidgeProtocolConfig }} context - The validated context required by the operation.
 * @param {string} hash - The transaction or route hash to process.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
async function waitForApproval (context: {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
}, hash: string): Promise<void> {
  const timeoutMs = context.config.evm?.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const publicClient = context.config.evm?.publicClient
  if (publicClient?.waitForTransactionReceipt) {
    const receiptArgs: { hash: string, confirmations?: number, timeout?: number } = {
      hash,
      confirmations: context.config.evm?.approvalConfirmations ?? 1,
      timeout: timeoutMs
    }
    const receipt = await beforeApprovalDeadline(() => publicClient.waitForTransactionReceipt!(receiptArgs), deadline, hash, timeoutMs)
    const kind = classifyReceiptStatus(receipt)
    if (kind === 'reverted') throw new ButterConfigurationError('ERC20 approval transaction reverted', { hash })
    if (kind === 'unknown') throw new ButterConfigurationError('Could not confirm the ERC20 approval: unrecognized receipt status', { hash })
    return
  }
  const getReceipt = context.account?.getTransactionReceipt?.bind(context.account)
  // Unreachable: assertApprovalConfirmable already proved a receipt source
  // exists. Kept as a fail-closed backstop — never silently skip confirmation.
  if (!getReceipt) {
    throw new ButterConfigurationError(
      'ERC20 approval was sent with no receipt source to confirm it',
      { hash }
    )
  }
  while (Date.now() < deadline) {
    const receipt = await beforeApprovalDeadline(() => getReceipt(hash), deadline, hash, timeoutMs)
    if (receipt != null) {
      const kind = classifyReceiptStatus(receipt as EvmTransactionReceipt)
      if (kind === 'success') return
      if (kind === 'reverted') throw new ButterConfigurationError('ERC20 approval transaction reverted', { hash })
      // kind === 'unknown': not final yet — keep polling until the deadline.
    }
    await sleep(Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)))
  }
  throw approvalTimeoutError(hash, timeoutMs)
}

/**
 * Runs one approval lookup while enforcing the remaining confirmation deadline.
 *
 * @param {() => Promise<T>} operation - The asynchronous operation constrained by the deadline.
 * @param {number} deadline - The absolute millisecond deadline for the operation.
 * @param {string} hash - The transaction or route hash to process.
 * @param {number} timeoutMs - The operation timeout in milliseconds.
 * @returns {Promise<T>} The lookup result produced before the deadline.
 */
async function beforeApprovalDeadline<T> (operation: () => Promise<T>, deadline: number, hash: string, timeoutMs: number): Promise<T> {
  const remaining = Math.max(deadline - Date.now(), 0)
  if (remaining === 0) throw approvalTimeoutError(hash, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(approvalTimeoutError(hash, timeoutMs)), remaining)
      })
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Creates the configuration error reported when approval confirmation exceeds its deadline.
 *
 * @param {string} hash - The transaction or route hash to process.
 * @param {number} timeoutMs - The operation timeout in milliseconds.
 * @returns {ButterConfigurationError} The typed approval timeout error.
 */
function approvalTimeoutError (hash: string, timeoutMs: number): ButterConfigurationError {
  return new ButterConfigurationError('Timed out waiting for the ERC20 approval to confirm', { hash, timeoutMs })
}

/**
 * Sends an EVM transaction (carrying `data`/`chainId`) via `evm.walletClient`.
 *
 * The WDK account's generic `sendTransaction` is NOT used because the WDK
 * `Transaction` type only guarantees `{ to, value }`, so routing swap/approval
 * calldata through it could silently drop `data`. The wallet client carries a
 * bound `account.address` (validated against the WDK account) so the signer,
 * calldata initiator, and allowance owner cannot split.
 *
 * @param {{ account: ButterAccount | undefined config: ButterSwidgeProtocolConfig }} context - The validated context required by the operation.
 * @param {EvmTransactionRequest} tx - The transaction request to validate or send.
 * @returns {Promise<EvmSendResult>} The submitted transaction hash and optional measured fee.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
async function sendEvmTransaction (context: {
  account: ButterAccount | undefined
  config: ButterSwidgeProtocolConfig
}, tx: EvmTransactionRequest): Promise<EvmSendResult> {
  const walletClient = context.config.evm?.walletClient
  if (walletClient) return normalizeSend(await walletClient.sendTransaction(tx))
  throw new ButterConfigurationError('EVM execution requires evm.walletClient to carry the transaction calldata')
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
 * @returns {EvmSendResult} The validated transaction hash and optional measured fee.
 */
function normalizeSend (result: string | { hash?: string, fee?: bigint }): EvmSendResult {
  if (typeof result === 'string') return { hash: assertTransactionHash(result) }
  const hash = assertTransactionHash(result.hash)
  return result.fee != null ? { hash, fee: result.fee } : { hash }
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
 * @param {unknown} value - The value to parse, normalize, or validate.
 * @returns {string} The validated non-empty transaction hash.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
export function assertTransactionHash (value: unknown): string {
  if (typeof value !== 'string') {
    throw new ButterConfigurationError('Transaction sender did not return a hash', { hash: String(value), type: typeof value })
  }
  if (value.trim() === '') {
    throw new ButterConfigurationError('Transaction sender returned an empty transaction hash')
  }
  return value
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
export function assertGasFee (fee: unknown): bigint | undefined {
  if (fee == null) return undefined
  if (typeof fee !== 'bigint') {
    throw new ButterApiError('Transaction sender reported a non-bigint fee', { fee: String(fee), type: typeof fee })
  }
  if (fee < 0n) {
    throw new ButterApiError('Transaction sender reported a negative fee', { fee: fee.toString() })
  }
  return fee
}

/**
 * Waits for the requested delay without blocking the event loop.
 *
 * @param {number} ms - The delay duration in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the operation completes.
 */
function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
