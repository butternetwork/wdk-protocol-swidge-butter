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

import type {
  SwidgeFee,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction
} from '@tetherto/wdk-wallet/protocols'

export type {
  SwidgeFee,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction
}

/**
 * A Butter quote enriched with the provider-specific route `hash`. Pass it back
 * as `options.routeHash` to {@link ButterSwidgeProtocol.swidge} to pin the exact
 * quoted route instead of allowing an automatic re-quote at execution time.
 */
export type ButterSwidgeQuote = SwidgeQuote & { routeHash: string }

/** Butter-specific execution options layered on top of the WDK `SwidgeOptions`. */
export interface ButterSwidgeExecutionOptions {
  /** Route hash from a prior {@link ButterSwidgeQuote} to pin the approved quote. */
  routeHash?: string
  /**
   * Overrides the configured `maxNativeFee` for this call only.
   *
   * The absolute cap on `routerFee + bridgeFee` is the guard that actually bounds
   * native spend (the bridge messaging fee inside `tx.value` is trusted from
   * `/swap`), and a single construction-time value cannot fit both a 10 USD and a
   * 100k USD transfer — too low and small routes are unusable, too high and the
   * cap is nominal. The caller knows the size at call time, so it can size the cap.
   *
   * `0n` is a meaningful value (allow no native fee at all) and takes precedence
   * over a configured cap; omit the field to inherit the configured one. Setting
   * it here satisfies the cross-chain fail-closed requirement.
   */
  maxNativeFee?: number | bigint
}

/** WDK swidge options plus Butter's provider-specific execution fields. */
export type ButterSwidgeOptions = SwidgeOptions & ButterSwidgeExecutionOptions

/**
 * Structural subset of a WDK wallet account used by the Butter provider.
 *
 * Mirrors `IWalletAccountReadOnly` / `IWalletAccount` from `@tetherto/wdk-wallet`:
 * read-only accounts expose {@link getAddress} and {@link getTransactionReceipt},
 * while full accounts additionally expose {@link sendTransaction}. Execution
 * always requires a full account; the built-in EVM path additionally requires
 * `evm.walletClient` to carry calldata, because the WDK `Transaction` type is
 * only `{ to, value }`. The account is used for the sender address and approval
 * receipts, never to submit swap/approval calldata.
 */
export interface ButterAccount {
  /** Returns the account's address (present on every WDK account shape). */
  getAddress: () => Promise<string> | string
  /** Sends a transaction; present only on full (send-capable) accounts. */
  sendTransaction?: (tx: unknown) => Promise<{ hash?: string, fee?: bigint } | string>
  /** Returns a transaction's receipt, or null while unconfirmed. */
  getTransactionReceipt?: (hash: string) => Promise<unknown | null>
}

/** Fetch response subset consumed by the Butter HTTP client. */
export interface ButterFetchResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/** Fetch-compatible function used for dependency injection and testing. */
export type ButterFetch = (url: string, init?: { method?: string, headers?: Record<string, string> }) => Promise<ButterFetchResponse>

/** Minimal EVM transaction receipt shape used for success/status checks. */
export interface EvmTransactionReceipt {
  status?: string | number | boolean
}

/** Read-only EVM client capabilities needed for allowance and receipt checks. */
export interface EvmPublicClient {
  readContract: (args: unknown) => Promise<bigint>
  waitForTransactionReceipt?: (args: { hash: string, confirmations?: number, timeout?: number }) => Promise<EvmTransactionReceipt>
  /** Fetches a receipt without waiting; used for same-chain status lookups. */
  getTransactionReceipt?: (hash: string) => Promise<EvmTransactionReceipt | null>
  /**
   * Fetches a sent transaction (for its calldata `input`). Used to statelessly
   * classify a swidge as same- or cross-chain when status hints are omitted.
   */
  getTransaction?: (hash: string) => Promise<{ input?: string, to?: string } | null>
}

/**
 * EVM wallet client capabilities needed for transaction submission. `account` is
 * required — the sender address must be resolvable. A raw viem wallet client is
 * not structurally assignable to this; wrap it with {@link toEvmWalletClient}.
 */
export interface EvmWalletClient {
  account: { address: string }
  sendTransaction: (args: unknown) => Promise<string | { hash?: string, fee?: bigint }>
}

/** Loose shape of a viem-style wallet client accepted by {@link toEvmWalletClient}. */
export interface ViemWalletClientLike {
  account?: { address: string } | null
  // `any` parameter so any viem client's strongly-typed sendTransaction is assignable.
  sendTransaction: (args: any) => Promise<`0x${string}`>
}

/** Loose shape of a viem-style public client accepted by `toEvmPublicClient`. */
export interface ViemPublicClientLike {
  // `any` parameters so any viem public client's strongly-typed methods are assignable.
  readContract: (args: any) => Promise<unknown>
  waitForTransactionReceipt: (args: any) => Promise<EvmTransactionReceipt>
  getTransactionReceipt: (args: any) => Promise<EvmTransactionReceipt>
  getTransaction: (args: any) => Promise<{ input?: string, to?: string | null }>
}

/**
 * An adapter's result: the transaction to send, plus its role. When an adapter
 * may produce more than one transaction per operation it MUST return this shape
 * (with `type`) so the primary `source` transaction is identifiable; a bare
 * return is treated as a single, untyped `source` transaction.
 */
export interface ButterAdapterResult {
  transaction: unknown
  type?: SwidgeTransaction['type']
}

/**
 * Converts Butter transaction data for a non-viem execution environment.
 *
 * Return a bare transaction (any shape the target chain's sender accepts) for the
 * common single-transaction case, or a {@link ButterAdapterResult} to classify a
 * transaction's role — required when an operation produces more than one, so the
 * primary `source` transaction is identifiable. The return stays `unknown` because
 * non-EVM transaction shapes are open-ended; use `ButterAdapterResult` for the
 * typed, classifiable form.
 */
export type ButterTransactionAdapter = (swapTx: ButterSwapTx, context: {
  sender: string
  receiver: string
  route: ButterRoute
  options: SwidgeOptions
}) => unknown

/** How this instance would execute on a given chain. */
export type ButterChainExecution = 'native' | 'adapter' | 'quote-only'

/**
 * A supported chain enriched with the Butter-specific `execution` mode, so the
 * extra field is visible in the public type rather than only at runtime.
 */
export type ButterSupportedChain = SwidgeSupportedChain & { execution: ButterChainExecution }

/** Router calldata validator versions implemented by this package. */
export type ButterRouterVersion = 'v3'

/** Allowlisted Butter Router deployment and its validator version. */
export interface ButterRouterDeployment {
  address: `0x${string}`
  version: ButterRouterVersion
}

/** Construction and execution configuration for {@link ButterSwidgeProtocol}. */
export interface ButterSwidgeProtocolConfig extends SwidgeProtocolConfig {
  /** Source chain handled by this protocol instance. */
  sourceChainId: string | number
  /** Butter-issued integration entrance identifier. */
  entrance: string
  apiKeyId?: string | undefined
  apiSecret?: string | undefined
  authMode?: 'required' | 'optional'
  routerBaseUrl?: string
  tokenBaseUrl?: string
  appBaseUrl?: string
  fetch?: ButterFetch
  now?: () => number
  routerContracts?: Partial<Record<number, readonly ButterRouterDeployment[]>>
  tokenDecimals?: Record<string, number>
  /** Per-chain native token decimals overriding built-in chain defaults. */
  nativeTokenDecimals?: Record<string, number>
  /** Additional chain IDs requiring Butter's strict 300 bps slippage floor. */
  strictSlippageChainIds?: Array<string | number>
  /**
   * Butter affiliate collecting the integrator's share, formatted
   * `<nickname>` or `<nickname>:<rate>`. Validated at construction.
   *
   * **Leaving this unset does not make the swap cheaper.** Butter substitutes its
   * own default affiliate wallet when the parameter is absent, so the fee is
   * charged to the user either way — omitting it only forgoes the integrator's
   * share. Changing it participates in the route cache key, so a route quoted
   * under a previous affiliate is never reused.
   */
  affiliate?: string
  /**
   * Butter referrer. **Mandatory for Solana same-chain routes** (a Solana
   * same-chain request without it throws `ButterConfigurationError`); optional on
   * EVM. Also participates in the route cache key.
   */
  referrer?: string
  /**
   * Seconds of remaining route lifetime required before a quote may be
   * **executed** (default 45). Execution still has to complete a `/swap`
   * round-trip, an optional ERC-20 approval, and the swap send, so a route that
   * is merely un-expired is not good enough. Set this above
   * `evm.approvalTimeoutMs / 1000` when approvals are expected. A pinned
   * `routeHash` inside the margin is rejected rather than silently re-quoted.
   */
  routeExecutionMarginSeconds?: number
  /**
   * Absolute ceiling (source-chain native base units) on the non-input native
   * value a `/swap` transaction may spend — the router protocol fee plus the
   * cross-chain bridge messaging fee (`routerFee + bridgeFee`). When set, the cap
   * is enforced on **any** chain (same-chain carries only the router fee, since
   * its bridge fee is zero). The cross-chain bridge messaging fee comes from the
   * (partially trusted) `/swap` calldata and is not otherwise bounded by the
   * quote, so **cross-chain execution requires this cap and fails closed without
   * it**; same-chain swaps do not require it.
   */
  maxNativeFee?: number | bigint
  /**
   * Per-chain adapters converting Butter `/swap` data for non-EVM execution.
   *
   * Trust boundary note: adapter execution bypasses the Router V3 calldata
   * validation performed on the built-in EVM path. Only the transaction's
   * chain ID and required fields are checked; the adapter is responsible for
   * any deeper validation of the provider-supplied transaction data.
   */
  transactionAdapters?: Record<string, ButterTransactionAdapter>
  evm?: {
    /**
     * Read-only client for ERC-20 allowance checks. Optional: without it the
     * provider skips the allowance read and always submits an approval.
     */
    publicClient?: EvmPublicClient
    /**
     * EVM-capable sender that carries the swap/approval calldata. Required for
     * built-in EVM execution. Its `account.address` is validated against the WDK
     * account so the signer, calldata initiator, and allowance owner never split.
     * Wrap a viem wallet client with {@link toEvmWalletClient}.
     */
    walletClient?: EvmWalletClient
    approvalConfirmations?: number
    approvalTimeoutMs?: number
  }
}

/** Token metadata returned inside a Butter route. */
export interface ButterRouteToken {
  address?: string
  decimals?: number | string
  symbol?: string
  name?: string
}

/** A single DEX/bridge leg within a chain's route segment. */
export interface ButterRouteLeg {
  /** Per-leg price impact; Butter reports priceImpact here, not at the route top level. */
  priceImpact?: string | number
}

/** Per-chain route segment returned by Butter. */
export interface ButterRouteChain {
  chainId?: string | number
  tokenIn?: ButterRouteToken
  tokenOut?: ButterRouteToken
  totalAmountIn?: string
  totalAmountOut?: string
  totalAmountInUSD?: string
  totalAmountOutUSD?: string
  /** Ordered legs for this segment; the final leg carries the segment's price impact. */
  route?: ButterRouteLeg[]
}

/** Normalized shape of a Butter `/route` result. */
export interface ButterRoute {
  hash: string
  timestamp?: number
  hasLiquidity?: boolean
  timeEstimated?: number
  estimatedTime?: number
  contract?: string
  priceImpact?: string | number
  bridgeFee?: ButterBridgeFee
  gasFee?: ButterFee
  swapFee?: { nativeFee?: string, tokenFee?: string, nativeSymbol?: string, tokenSymbol?: string }
  /** Integrator/affiliate fee config mirrored into the `/swap` calldata feeData. */
  feeConfig?: ButterFeeConfig
  minAmountOut?: { amount?: string, symbol?: string }
  amountOutMin?: string
  srcChain?: ButterRouteChain
  bridgeChain?: ButterRouteChain
  dstChain?: ButterRouteChain
  totalAmountIn?: string
  totalAmountOut?: string
  totalAmountInUSD?: string
  totalAmountOutUSD?: string
}

/** Butter `/route` integrator fee configuration, encoded on-chain as `feeData`. */
export interface ButterFeeConfig {
  feeType?: number | string
  referrer?: string
  rateOrNativeFee?: string | number
}

/** Common Butter fee fields. */
export interface ButterFee {
  amount?: string
  symbol?: string
  address?: string
  chainId?: string | number
  inUSD?: string
}

/** Token-denominated component of a Butter bridge fee. */
export interface ButterFeePart {
  amount?: string
  token?: ButterRouteToken
}

/** Detailed bridge and affiliate fee information. */
export interface ButterBridgeFee extends ButterFee {
  in?: ButterFeePart
  out?: ButterFeePart
  affiliate?: ButterFeePart & { list?: unknown[], data?: string }
}

/** Transaction request returned by Butter `/swap`. */
export interface ButterSwapTx {
  to: string
  value: string
  chainId: string | number
  data?: string | undefined
  method?: string | undefined
  args?: unknown[] | undefined
  memo?: string | undefined
}

/** Chain metadata returned by Butter discovery APIs. */
export interface ButterChainInfo {
  id?: string | number
  chainId?: string | number
  chainType?: string
  type?: string
  name?: string
  key?: string
  nativeToken?: string | ButterTokenInfo
}

/** Token metadata returned by Butter discovery APIs. */
export interface ButterTokenInfo {
  chainId?: string | number
  address?: string
  token?: string
  decimals?: number | string
  decimal?: number | string
  symbol?: string
  name?: string
}

/** EVM transaction request passed to configured senders. */
export interface EvmTransactionRequest {
  to: `0x${string}` | string
  value?: bigint | undefined
  data?: `0x${string}` | string | undefined
  chainId?: number | undefined
}

/** Internal cached route envelope. */
export interface CachedRoute {
  key: string
  route: ButterRoute
  slippageBps: number
  expiresAt: number
}
