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
  SwidgeStatusOptions,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction
} from '@tetherto/wdk-wallet/protocols'
import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem'

export type {
  SwidgeFee,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusOptions,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction
}

/**
 * How far `toTokenAmountMin` is actually guaranteed at execution time.
 *
 * `enforced` — same-chain. The minimum is checked against the Router calldata
 * (`swapAndCall`'s `minAmount`), so the transaction reverts below it.
 *
 * `quoted-only` — cross-chain. The destination leg's minimum lives in the nested
 * bridge payload, which this package intentionally trusts to Butter rather than
 * re-verifying (see the trust boundary in `AGENTS.md`). The value is Butter's own
 * estimate, not a checked guarantee. WDK's field description calls it a "minimum
 * guaranteed amount", so this flag exists to make the difference visible in code
 * instead of only in prose.
 */
export type ButterDestinationGuarantees = 'enforced' | 'quoted-only'

/**
 * A Butter quote enriched with the provider-specific route `hash`. Pass it back
 * as `options.routeHash` to {@link ButterSwidgeProtocol.swidge} to pin the exact
 * quoted route instead of allowing an automatic re-quote at execution time.
 */
export type ButterSwidgeQuote = SwidgeQuote & {
  /** Butter route identifier that can pin the same route during execution. */
  routeHash: string
  /** Whether the quoted destination minimum is verified by this package at execution. */
  destinationGuarantees: ButterDestinationGuarantees
}

/**
 * WDK status hints plus Butter's `byOrderId` lookup.
 *
 * Set `byOrderId` to resolve a Butter **order ID** instead of a source-chain
 * transaction hash. Note that this package never produces one: `SwidgeResult.id`
 * is always the source hash, and neither `/route`, `/swap`, nor
 * `queryBridgeInfoBySourceHash` returns an order ID. The flag exists for callers
 * who obtained an order ID from Butter by some other route (a dashboard or a
 * direct API call); with it set, `id` is passed to `queryCrossInfoByOrderId` and is
 * not treated as a hash.
 */
export type ButterSwidgeStatusOptions = SwidgeStatusOptions & {
  /** Treats the supplied status identifier as a Butter order ID instead of a source transaction hash. */
  byOrderId?: boolean
}

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

/** Transaction result returned by a host-supplied WDK or EVM sender. */
interface ButterSenderResult {
  /** Broadcast transaction hash. */
  hash?: string
  /** Measured network fee in source-chain native base units. */
  fee?: bigint
}

/** Bound EVM account address exposed by a wallet client. */
interface EvmBoundAccount {
  /** Address that signs submitted transactions. */
  address: string
}

/** Receipt-wait options accepted by the provider's EVM client abstraction. */
interface EvmReceiptWaitOptions {
  /** Broadcast transaction hash. */
  hash: string
  /** Number of confirmations required before returning. */
  confirmations?: number
  /** Maximum receipt wait in milliseconds. */
  timeout?: number
}

/** Transaction fields used to attribute a source hash to Butter Router calldata. */
interface EvmTransactionSummary {
  /** Encoded transaction calldata. */
  input?: string
  /** Transaction recipient, when the provider reports one. */
  to?: string | null
}

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
  sendTransaction?: (tx: unknown) => Promise<ButterSenderResult | string>
  /** Returns a transaction's receipt, or null while unconfirmed. */
  getTransactionReceipt?: (hash: string) => Promise<unknown | null>
}

/** Fetch response subset consumed by the Butter HTTP client. */
export interface ButterFetchResponse {
  /** Whether the HTTP response status is successful. */
  ok: boolean
  /** Numeric HTTP response status. */
  status: number
  /** Parses the response body as JSON. */
  json: () => Promise<unknown>
  /**
   * Optional so an existing test double supplying only `json` stays valid. When
   * present it is used to capture a failed response's body, which is frequently
   * not JSON at all (a gateway's HTML error page).
   */
  text?: () => Promise<string>
}

/** Fetch-compatible function used for dependency injection and testing. */
export type ButterFetch = (url: string, init?: { method?: string, headers?: Record<string, string>, signal?: AbortSignal }) => Promise<ButterFetchResponse>

/** Minimal EVM transaction receipt shape used for success/status checks. */
export interface EvmTransactionReceipt {
  /** Provider-specific receipt status classified by this package as success, revert, or unknown. */
  status?: string | number | boolean
}

/** Read-only EVM client capabilities needed for allowance and receipt checks. */
export interface EvmPublicClient {
  /** Reads an EVM contract; used for ERC-20 allowance lookup. */
  readContract: (args: unknown) => Promise<bigint>
  /** Waits for a submitted approval transaction to receive the requested confirmations. */
  waitForTransactionReceipt?: (args: EvmReceiptWaitOptions) => Promise<EvmTransactionReceipt>
  /** Fetches a receipt without waiting; used for same-chain status lookups. */
  getTransactionReceipt?: (hash: string) => Promise<EvmTransactionReceipt | null>
  /**
   * Fetches a sent transaction (for its calldata `input`). Used to statelessly
   * classify a swidge as same- or cross-chain when status hints are omitted.
   */
  getTransaction?: (hash: string) => Promise<EvmTransactionSummary | null>
}

/**
 * EVM wallet client capabilities needed for transaction submission. `account` is
 * required — the sender address must be resolvable. A raw viem wallet client is
 * not structurally assignable to this; wrap it with {@link toEvmWalletClient}.
 */
export interface EvmWalletClient {
  /** Bound signing account whose address must match the WDK account. */
  account: EvmBoundAccount
  /** Broadcasts an EVM transaction carrying Router or approval calldata. */
  sendTransaction: (args: unknown) => Promise<string | ButterSenderResult>
}

/** Loose shape of a viem-style wallet client accepted by {@link toEvmWalletClient}. */
export interface ViemWalletClientLike {
  /** Bound viem account; an absent account is rejected by the adapter. */
  account?: EvmBoundAccount | null
  /** viem transaction submission method. */
  sendTransaction: (args: Parameters<WalletClient<Transport, Chain | undefined, Account>['sendTransaction']>[0]) => Promise<`0x${string}`>
}

/** Loose shape of a viem-style public client accepted by `toEvmPublicClient`. */
export interface ViemPublicClientLike {
  /** viem contract-read method used for ERC-20 allowance lookup. */
  readContract: (args: Parameters<PublicClient['readContract']>[0]) => Promise<unknown>
  /** viem receipt waiter used to confirm approvals. */
  waitForTransactionReceipt: (args: Parameters<PublicClient['waitForTransactionReceipt']>[0]) => Promise<EvmTransactionReceipt>
  /** viem receipt lookup used by same-chain status checks. */
  getTransactionReceipt: (args: Parameters<PublicClient['getTransactionReceipt']>[0]) => Promise<EvmTransactionReceipt>
  /** viem transaction lookup used to attribute a source hash to a Butter Router call. */
  getTransaction: (args: Parameters<PublicClient['getTransaction']>[0]) => Promise<EvmTransactionSummary>
}

/**
 * An adapter's result: the transaction to send, plus its role. When an adapter
 * may produce more than one transaction per operation it MUST return this shape
 * (with `type`) so the primary `source` transaction is identifiable; a bare
 * return is treated as a single, untyped `source` transaction.
 */
export interface ButterAdapterResult {
  /** Chain-specific transaction object returned to the configured WDK account. */
  transaction: unknown
  /** Role used to identify the single source transaction in multi-transaction adapter output. */
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
  /** Source account address supplied to Butter. */
  sender: string
  /** Destination recipient supplied to Butter. */
  receiver: string
  /** Validated route associated with the transaction data. */
  route: ButterRoute
  /** Original WDK operation options. */
  options: SwidgeOptions
}) => unknown

/** How this instance would execute on a given chain. */
export type ButterChainExecution = 'native' | 'adapter' | 'quote-only'

/**
 * A supported chain enriched with the Butter-specific `execution` mode, so the
 * extra field is visible in the public type rather than only at runtime.
 */
export type ButterSupportedChain = SwidgeSupportedChain & {
  /** How the configured protocol instance can execute on this chain. */
  execution: ButterChainExecution
}

/** Router calldata validator versions implemented by this package. */
export type ButterRouterVersion = 'v3'

/** Allowlisted Butter Router deployment and its validator version. */
export interface ButterRouterDeployment {
  /** Allowlisted EVM Router contract address. */
  address: `0x${string}`
  /** Calldata-validation version implemented for this deployment. */
  version: ButterRouterVersion
}

/** A non-fatal condition reported through {@link ButterSwidgeProtocolConfig.onWarning}. */
export interface ButterWarning {
  /**
   * Stable machine-readable identifier. `mixed-currency-protocol-fees` — the
   * `protocol` fee group spans more than one token, so the WDK base class's legacy
   * `bridgeFee` scalar is summing across currencies. `no-fees-reported` — Butter
   * reported no fees at all, so `fees[]` carries a single zero-amount placeholder.
   * `bridge-fee-components-missing` — the bridge fee arrived as a top-level summary
   * with no `in`, `out` or `affiliate` component. The summary is never priced (one
   * figure in one token cannot describe a fee spanning three), so the bridge fee is
   * omitted from `fees[]` and a configured protocol cap refuses.
   */
  code:
    | 'mixed-currency-protocol-fees'
    | 'no-fees-reported'
    | 'bridge-fee-components-missing'
  /** Human-readable warning suitable for logs or telemetry. */
  message: string
  /** Additional warning context; shape depends on the warning code. */
  details?: unknown
}

/** Construction and execution configuration for {@link ButterSwidgeProtocol}. */
export interface ButterSwidgeProtocolConfig extends SwidgeProtocolConfig {
  /** Source chain handled by this protocol instance. */
  sourceChainId: string | number
  /** Butter-issued integration entrance identifier. */
  entrance: string
  /** Butter API key identifier; configure only together with {@link apiSecret}. */
  apiKeyId?: string | undefined
  /** Butter API secret. Keep server-side and never include it in logs or client bundles. */
  apiSecret?: string | undefined
  /** Authentication policy for Butter requests (default: `optional`). */
  authMode?: 'required' | 'optional'
  /** Router API base URL (default: Butter's production Router endpoint). */
  routerBaseUrl?: string
  /** Token API base URL (default: Butter's production token endpoint). */
  tokenBaseUrl?: string
  /** App/status API base URL (default: Butter's production app endpoint). */
  appBaseUrl?: string
  /** Complete Butter HTTP request deadline in milliseconds (default 10,000). */
  requestTimeoutMs?: number
  /** Fetch-compatible HTTP implementation, primarily for server runtimes and deterministic tests. */
  fetch?: ButterFetch
  /** Epoch-seconds clock override used for route expiry and cache tests. */
  now?: () => number
  /** Per-chain Router allowlist overrides; an empty chain entry disables built-in execution there. */
  routerContracts?: Partial<Record<number, readonly ButterRouterDeployment[]>>
  /** Source-token decimals keyed by chain-format-aware token identifier. */
  tokenDecimals?: Record<string, number>
  /** Per-chain native token decimals overriding built-in chain defaults. */
  nativeTokenDecimals?: Record<string, number>
  /** Additional chain IDs requiring Butter's strict 300 bps slippage floor. */
  strictSlippageChainIds?: (string | number)[]
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
   * Notified about conditions that are not errors but that a caller reading only
   * the WDK surface would otherwise never see — chiefly that the base class's
   * legacy `fee`/`bridgeFee` scalars are summing across denominations for this
   * route, so only the itemised `fees[]` is meaningful.
   *
   * Called synchronously during quoting; a throw from the callback would abort the
   * quote, so keep it side-effect free (log, count, forward).
   */
  onWarning?: (warning: ButterWarning) => void
  /**
   * Additional chain IDs to treat as EVM for the address-family check.
   *
   * `swidge` requires an explicit `recipient` whenever the destination chain's
   * address family differs from the source's **or** is unrecognized, since WDK's
   * "recipient defaults to the wallet address" only holds within one family. Butter
   * adds chains faster than this package is republished, so use this to accept an
   * EVM chain the built-in table does not list yet, instead of passing a recipient
   * on every call.
   */
  evmChainIds?: (string | number)[]
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
  /** EVM read and write capabilities used by the built-in Router execution path. */
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
    /** Approval receipt confirmations requested from the public client (default: provider behavior). */
    approvalConfirmations?: number
    /** Approval confirmation deadline in milliseconds (default 10,000). Zero means immediate timeout. */
    approvalTimeoutMs?: number
  }
}

/** Token metadata returned inside a Butter route. */
export interface ButterRouteToken {
  /** Chain-native token identifier or contract/mint address. */
  address?: string
  /** Decimal precision as returned by Butter; string form is accepted at the API boundary. */
  decimals?: number | string
  /** Human-readable token symbol. */
  symbol?: string
  /** Human-readable token name. */
  name?: string
}

/** A single DEX/bridge leg within a chain's route segment. */
export interface ButterRouteLeg {
  /** Per-leg price impact; Butter reports priceImpact here, not at the route top level. */
  priceImpact?: string | number
}

/** Per-chain route segment returned by Butter. */
export interface ButterRouteChain {
  /** Butter chain identifier for this route segment. */
  chainId?: string | number
  /** Input token metadata for this segment. */
  tokenIn?: ButterRouteToken
  /** Output token metadata for this segment. */
  tokenOut?: ButterRouteToken
  /** Decimal input amount reported for this segment. */
  totalAmountIn?: string
  /** Decimal output amount reported for this segment. */
  totalAmountOut?: string
  /** USD valuation of the input amount, used only for cross-denominated fee ratios. */
  totalAmountInUSD?: string
  /** USD valuation of the output amount, used only for cross-denominated fee ratios. */
  totalAmountOutUSD?: string
  /** Ordered legs for this segment; the final leg carries the segment's price impact. */
  route?: ButterRouteLeg[]
}

/** Normalized shape of a Butter `/route` result. */
export interface ButterRoute {
  /** Stable Butter route identifier required by `/swap`. */
  hash: string
  /** Route creation time in epoch seconds. */
  timestamp?: number
  /** Whether Butter reports usable liquidity for this candidate. */
  hasLiquidity?: boolean
  /** Primary estimated duration in seconds. */
  timeEstimated?: number
  /** Alternate estimated-duration field returned by some Butter endpoints. */
  estimatedTime?: number
  /** Router contract Butter expects `/swap` to target. */
  contract?: string
  /** Route-level price impact when Butter supplies one. */
  priceImpact?: string | number
  /** Bridge and affiliate fee metadata. */
  bridgeFee?: ButterBridgeFee
  /** Source-chain network fee metadata. */
  gasFee?: ButterFee
  /** Authoritative Butter swap-fee amounts and display symbols. */
  swapFee?: {
    /** Swap fee charged in the source chain's native token. */
    nativeFee?: string
    /** Swap fee charged in the source token. */
    tokenFee?: string
    /** Display symbol for the native fee. */
    nativeSymbol?: string
    /** Display symbol for the source-token fee. */
    tokenSymbol?: string
  }
  /** Referrer fee config mirrored into `/swap` feeData; its charge is already included in `swapFee`. */
  feeConfig?: ButterFeeConfig
  /** Preferred minimum-output representation returned by Butter. */
  minAmountOut?: {
    /** Decimal minimum destination amount. */
    amount?: string
    /** Destination-token display symbol. */
    symbol?: string
  }
  /** Legacy scalar minimum-output field. */
  amountOutMin?: string
  /** Source-chain route segment. */
  srcChain?: ButterRouteChain
  /** Bridge route segment, when separately reported. */
  bridgeChain?: ButterRouteChain
  /** Destination-chain route segment for cross-chain routes. */
  dstChain?: ButterRouteChain
  /** Route-level decimal input amount. */
  totalAmountIn?: string
  /** Route-level decimal output amount. */
  totalAmountOut?: string
  /** Route-level USD input valuation. */
  totalAmountInUSD?: string
  /** Route-level USD output valuation. */
  totalAmountOutUSD?: string
}

/** Butter `/route` referrer fee configuration, encoded on-chain as `feeData`. */
export interface ButterFeeConfig {
  /** Fee mode encoded into Router calldata; supported values are 0 and 1. */
  feeType?: number | string
  /** Referrer address encoded into Router calldata. */
  referrer?: string
  /** Native fixed fee or proportional rate encoded into Router calldata. */
  rateOrNativeFee?: string | number
}

/** Common Butter fee fields. */
export interface ButterFee {
  /** Decimal fee amount. */
  amount?: string
  /** Human-readable fee-token symbol. */
  symbol?: string
  /** Fee-token identifier. */
  address?: string
  /** Chain on which the fee is charged. */
  chainId?: string | number
  /** Butter-reported USD valuation. */
  inUSD?: string
}

/** Token-denominated component of a Butter bridge fee. */
export interface ButterFeePart {
  /** Decimal component amount. */
  amount?: string
  /** Token in which this component is charged. */
  token?: ButterRouteToken
}

/** Detailed bridge and affiliate fee information. */
export interface ButterBridgeFee extends ButterFee {
  /** Inbound bridge fee component. */
  in?: ButterFeePart
  /** Outbound bridge fee component. */
  out?: ButterFeePart
  /** Affiliate fee component and opaque Butter attribution metadata. */
  affiliate?: ButterFeePart & {
    /** Opaque affiliate allocation entries returned by Butter. */
    list?: unknown[]
    /** Opaque affiliate encoding returned by Butter. */
    data?: string
  }
}

/** Transaction request returned by Butter `/swap`. */
export interface ButterSwapTx {
  /** Transaction recipient or chain-specific destination. */
  to: string
  /** Native transaction value encoded as a decimal or hexadecimal integer string. */
  value: string
  /** Source chain that must broadcast this transaction. */
  chainId: string | number
  /** Optional encoded transaction calldata. */
  data?: string | undefined
  /** Optional human-readable method metadata; calldata remains authoritative. */
  method?: string | undefined
  /** Optional chain-adapter arguments returned by Butter. */
  args?: unknown[] | undefined
  /** Optional memo required by account-based non-EVM destinations. */
  memo?: string | undefined
}

/** Chain metadata returned by Butter discovery APIs. */
export interface ButterChainInfo {
  /** Router API chain identifier. */
  id?: string | number
  /** Token API chain identifier alias. */
  chainId?: string | number
  /** Chain virtual-machine family reported by the token API. */
  chainType?: string
  /** Chain virtual-machine family reported by the Router API. */
  type?: string
  /** Human-readable chain name. */
  name?: string
  /** Butter chain lookup key. */
  key?: string
  /** Native-token metadata, sometimes serialized as JSON. */
  nativeToken?: string | ButterTokenInfo
}

/** Token metadata returned by Butter discovery APIs. */
export interface ButterTokenInfo {
  /** Chain that owns this token entry. */
  chainId?: string | number
  /** Token contract, mint, or native identifier. */
  address?: string
  /** Alternate token identifier field returned by some Butter endpoints. */
  token?: string
  /** Preferred decimal-precision field. */
  decimals?: number | string
  /** Legacy decimal-precision alias. */
  decimal?: number | string
  /** Human-readable token symbol. */
  symbol?: string
  /** Human-readable token name. */
  name?: string
}

/** EVM transaction request passed to configured senders. */
export interface EvmTransactionRequest {
  /** Transaction destination. */
  to: `0x${string}` | string
  /** Native value in base units. */
  value?: bigint | undefined
  /** Encoded EVM calldata. */
  data?: `0x${string}` | string | undefined
  /** Numeric EVM chain identifier. */
  chainId?: number | undefined
}

/** Internal cached route envelope. */
export interface CachedRoute {
  key: string
  route: ButterRoute
  slippageBps: number
  /**
   * Source-token decimals resolved by this package (config / `/findToken` / native
   * default) and used to build the request — NOT the route's own reported value.
   */
  sourceDecimals: number
  expiresAt: number
}
