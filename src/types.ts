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
import type { PublicClient, WalletClient } from 'viem'

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
  /** Butter route hash that can pin a later execution. */
  routeHash: string
  /** Whether execution validates the destination minimum or reports it as quote-only. */
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
  /** Treats `id` as an externally obtained Butter order ID instead of a source hash. */
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
  /** Whether the HTTP status is successful. */
  ok: boolean
  /** The numeric HTTP response status. */
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

/**
 * Fetch-compatible function used for dependency injection and testing.
 *
 * @param {string} url - The complete Butter endpoint URL.
 * @param {{ method?: string, headers?: Record<string, string>, signal?: AbortSignal }} [init] - Optional request method, headers, and abort signal.
 * @returns {Promise<ButterFetchResponse>} The minimal response consumed by the provider.
 */
export type ButterFetch = (url: string, init?: { method?: string, headers?: Record<string, string>, signal?: AbortSignal }) => Promise<ButterFetchResponse>

/** Minimal EVM transaction receipt shape used for success/status checks. */
export interface EvmTransactionReceipt {
  /** The provider-specific receipt status used for fail-closed classification. */
  status?: string | number | boolean
}

export interface EvmTransactionData {
  /** The transaction calldata used for Router attribution. */
  input?: string
  /** The transaction target used for Router allowlist checks. */
  to?: string
}

interface ViemTransactionData {
  /** The transaction calldata returned by viem. */
  input?: string
  /** The nullable transaction target returned by viem. */
  to?: string | null
}

type BivariantAsyncMethod<TArgs, TResult> = {
  bivarianceHack(args: TArgs): Promise<TResult>
}['bivarianceHack']

/** Read-only EVM client capabilities needed for allowance and receipt checks. */
export interface EvmPublicClient {
  /** Reads an ERC-20 allowance or another integer contract value. */
  readContract: BivariantAsyncMethod<Parameters<PublicClient['readContract']>[0], bigint>
  /** Waits for a submitted transaction to reach the requested confirmation count. */
  waitForTransactionReceipt?: (args: { hash: string, confirmations?: number, timeout?: number }) => Promise<EvmTransactionReceipt>
  /** Fetches a receipt without waiting; used for same-chain status lookups. */
  getTransactionReceipt?: (hash: string) => Promise<EvmTransactionReceipt | null>
  /**
   * Fetches a sent transaction (for its calldata `input`). Used to statelessly
   * classify a swidge as same- or cross-chain when status hints are omitted.
   */
  getTransaction?: (hash: string) => Promise<EvmTransactionData | null>
}

/**
 * EVM wallet client capabilities needed for transaction submission. `account` is
 * required — the sender address must be resolvable. A raw viem wallet client is
 * not structurally assignable to this; wrap it with {@link toEvmWalletClient}.
 */
export interface EvmWalletClient {
  /** The account bound to every transaction submitted by the client. */
  account: { address: string }
  /** Submits an EVM transaction with calldata and optional chain metadata. */
  sendTransaction: (args: EvmTransactionRequest) => Promise<string | { hash?: string, fee?: bigint }>
}

/** Minimal viem wallet-client capabilities accepted by {@link toEvmWalletClient}. */
export interface ViemWalletClientLike {
  /** The optional account bound to the viem wallet client. */
  account?: { address: string } | null
  /** Submits a transaction through the wrapped viem wallet client. */
  sendTransaction: BivariantAsyncMethod<Parameters<WalletClient['sendTransaction']>[0], `0x${string}`>
}

/** Minimal viem public-client capabilities accepted by {@link toEvmPublicClient}. */
export interface ViemPublicClientLike {
  /** Reads a contract through the wrapped viem public client. */
  readContract: BivariantAsyncMethod<Parameters<PublicClient['readContract']>[0], unknown>
  /** Waits for a transaction receipt through viem. */
  waitForTransactionReceipt: BivariantAsyncMethod<Parameters<PublicClient['waitForTransactionReceipt']>[0], EvmTransactionReceipt>
  /** Fetches a transaction receipt through viem. */
  getTransactionReceipt: BivariantAsyncMethod<Parameters<PublicClient['getTransactionReceipt']>[0], EvmTransactionReceipt>
  /** Fetches transaction calldata and target metadata through viem. */
  getTransaction: BivariantAsyncMethod<Parameters<PublicClient['getTransaction']>[0], ViemTransactionData>
}

/**
 * An adapter's result: the transaction to send, plus its role. When an adapter
 * may produce more than one transaction per operation it MUST return this shape
 * (with `type`) so the primary `source` transaction is identifiable; a bare
 * return is treated as a single, untyped `source` transaction.
 */
export interface ButterAdapterResult {
  /** The host-specific transaction payload to broadcast. */
  transaction: unknown
  /** The transaction role used to select the operation id and status route. */
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
 *
 * @param {ButterSwapTx} swapTx - The transaction data returned by Butter `/swap`.
 * @param {{ sender: string, receiver: string, route: ButterRoute, options: SwidgeOptions }} context - The validated sender, recipient, route, and caller options.
 * @returns {unknown} A host-specific transaction or classified adapter result.
 */
export type ButterTransactionAdapter = (swapTx: ButterSwapTx, context: {
  /** The validated source account address. */
  sender: string
  /** The output recipient used for the Butter route. */
  receiver: string
  /** The route associated with the transaction data. */
  route: ButterRoute
  /** The caller options associated with the transaction data. */
  options: SwidgeOptions
}) => unknown

/** How this instance would execute on a given chain. */
export type ButterChainExecution = 'native' | 'adapter' | 'quote-only'

/**
 * A supported chain enriched with the Butter-specific `execution` mode, so the
 * extra field is visible in the public type rather than only at runtime.
 */
export type ButterSupportedChain = SwidgeSupportedChain & {
  /** How the current provider instance can execute on this chain. */
  execution: ButterChainExecution
}

/** Router calldata validator versions implemented by this package. */
export type ButterRouterVersion = 'v3'

/** Allowlisted Butter Router deployment and its validator version. */
export interface ButterRouterDeployment {
  /** The allowlisted Router contract address. */
  address: `0x${string}`
  /** The calldata validator version used for this deployment. */
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
  /** A human-readable explanation of the non-fatal condition. */
  message: string
  /** Optional structured context for logging or diagnostics. */
  details?: unknown
}

/** Construction and execution configuration for {@link ButterSwidgeProtocol}. */
export interface ButterSwidgeProtocolConfig extends SwidgeProtocolConfig {
  /** Source chain handled by this protocol instance. */
  sourceChainId: string | number
  /** Butter-issued integration entrance identifier. */
  entrance: string
  /** The Butter API key identifier; supply it together with `apiSecret`. */
  apiKeyId?: string | undefined
  /** The server-side Butter API secret; never expose it to browser clients. */
  apiSecret?: string | undefined
  /** Whether Butter credentials are optional or required (default: `optional`). */
  authMode?: 'required' | 'optional'
  /** The HTTPS base URL for Butter Router endpoints. */
  routerBaseUrl?: string
  /** The HTTPS base URL for Butter token endpoints. */
  tokenBaseUrl?: string
  /** The HTTPS base URL for Butter status endpoints. */
  appBaseUrl?: string
  /** Complete Butter HTTP request deadline in milliseconds (default 10,000). */
  requestTimeoutMs?: number
  /** The fetch implementation used for Butter HTTP requests. */
  fetch?: ButterFetch
  /** Returns the current Unix timestamp in seconds for deterministic expiry tests. */
  now?: () => number
  /** Per-chain Router allowlist overrides; each chain entry replaces its defaults. */
  routerContracts?: Partial<Record<number, readonly ButterRouterDeployment[]>>
  /** Source-token decimals keyed by token identifier for tokens Butter cannot resolve. */
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
  /** The EVM read, send, and approval-confirmation capabilities. */
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
    /** Receipt confirmations required before an ERC-20 approval is accepted. */
    approvalConfirmations?: number
    /** Approval confirmation deadline in milliseconds (default 10,000). Zero means immediate timeout. */
    approvalTimeoutMs?: number
  }
}

/** Token metadata returned inside a Butter route. */
export interface ButterRouteToken {
  /** The chain-specific token address or native identifier. */
  address?: string
  /** The token decimal count declared by Butter. */
  decimals?: number | string
  /** The human-readable token symbol. */
  symbol?: string
  /** The human-readable token name. */
  name?: string
}

/** A single DEX/bridge leg within a chain's route segment. */
export interface ButterRouteLeg {
  /** Per-leg price impact; Butter reports priceImpact here, not at the route top level. */
  priceImpact?: string | number
}

/** Per-chain route segment returned by Butter. */
export interface ButterRouteChain {
  /** The chain identifier for this route segment. */
  chainId?: string | number
  /** The token entering this route segment. */
  tokenIn?: ButterRouteToken
  /** The token leaving this route segment. */
  tokenOut?: ButterRouteToken
  /** The segment input amount as a decimal string. */
  totalAmountIn?: string
  /** The segment output amount as a decimal string. */
  totalAmountOut?: string
  /** Butter USD metadata for the segment input. */
  totalAmountInUSD?: string
  /** Butter USD metadata for the segment output. */
  totalAmountOutUSD?: string
  /** Ordered legs for this segment; the final leg carries the segment's price impact. */
  route?: ButterRouteLeg[]
}

/** Normalized shape of a Butter `/route` result. */
export interface ButterRoute {
  /** The route hash required by the `/swap` request. */
  hash: string
  /** The route creation time as a Unix timestamp in seconds. */
  timestamp?: number
  /** Whether Butter reports sufficient liquidity for the candidate. */
  hasLiquidity?: boolean
  /** The estimated route duration in seconds. */
  timeEstimated?: number
  /** Alternate Butter field for estimated duration in seconds. */
  estimatedTime?: number
  /** The Router address selected by Butter. */
  contract?: string
  /** Authoritative top-level price impact when Butter provides one. */
  priceImpact?: string | number
  /** The bridge fee summary and independently denominated components. */
  bridgeFee?: ButterBridgeFee
  /** The estimated source-chain network fee. */
  gasFee?: ButterFee
  /** The authoritative Butter swap fee amounts. */
  swapFee?: { nativeFee?: string, tokenFee?: string, nativeSymbol?: string, tokenSymbol?: string }
  /** Referrer fee config mirrored into `/swap` feeData; its charge is already included in `swapFee`. */
  feeConfig?: ButterFeeConfig
  /** The minimum destination amount and optional symbol. */
  minAmountOut?: { amount?: string, symbol?: string }
  /** Alternate Butter field for minimum destination amount. */
  amountOutMin?: string
  /** The source-chain route segment. */
  srcChain?: ButterRouteChain
  /** The bridge-chain route segment when supplied. */
  bridgeChain?: ButterRouteChain
  /** The destination-chain route segment for cross-chain routes. */
  dstChain?: ButterRouteChain
  /** Top-level route input amount as a decimal string. */
  totalAmountIn?: string
  /** Top-level route output amount as a decimal string. */
  totalAmountOut?: string
  /** Butter USD metadata for the route input. */
  totalAmountInUSD?: string
  /** Butter USD metadata for the route output. */
  totalAmountOutUSD?: string
}

/** Butter `/route` referrer fee configuration, encoded on-chain as `feeData`. */
export interface ButterFeeConfig {
  /** The Router fee encoding mode. */
  feeType?: number | string
  /** The address receiving the quoted referrer fee. */
  referrer?: string
  /** The quoted rate or native fee encoded in Router calldata. */
  rateOrNativeFee?: string | number
}

/** Common Butter fee fields. */
export interface ButterFee {
  /** The fee amount as a decimal string. */
  amount?: string
  /** The symbol of the fee token. */
  symbol?: string
  /** The address or identifier of the fee token. */
  address?: string
  /** The chain on which the fee is charged. */
  chainId?: string | number
  /** Butter USD metadata for the fee. */
  inUSD?: string
}

/** Token-denominated component of a Butter bridge fee. */
export interface ButterFeePart {
  /** The component amount as a decimal string. */
  amount?: string
  /** The token in which the component is denominated. */
  token?: ButterRouteToken
}

/** Detailed bridge and affiliate fee information. */
export interface ButterBridgeFee extends ButterFee {
  /** The source-side bridge fee component. */
  in?: ButterFeePart
  /** The destination-side bridge fee component. */
  out?: ButterFeePart
  /** The affiliate bridge fee component and raw metadata. */
  affiliate?: ButterFeePart & { list?: unknown[], data?: string }
}

/** Transaction request returned by Butter `/swap`. */
export interface ButterSwapTx {
  /** The transaction target returned by Butter. */
  to: string
  /** The native transaction value encoded as an integer string. */
  value: string
  /** The source chain on which to submit the transaction. */
  chainId: string | number
  /** The optional EVM calldata returned by Butter. */
  data?: string | undefined
  /** Optional method metadata accompanying EVM calldata. */
  method?: string | undefined
  /** Optional decoded argument metadata returned by Butter. */
  args?: unknown[] | undefined
  /** Optional memo used by non-EVM transaction adapters. */
  memo?: string | undefined
}

/** Chain metadata returned by Butter discovery APIs. */
export interface ButterChainInfo {
  /** The fallback chain identifier returned by the token API. */
  id?: string | number
  /** The Router chain identifier, which may be encoded as a string or number. */
  chainId?: string | number
  /** The Router's VM-family label for the chain. */
  chainType?: string
  /** The token API's fallback VM-family label. */
  type?: string
  /** The human-readable chain name shown during discovery. */
  name?: string
  /** The token API's short machine-readable chain key. */
  key?: string
  /** Native-token metadata, either embedded directly or JSON encoded. */
  nativeToken?: string | ButterTokenInfo
}

/** Token metadata returned by Butter discovery APIs. */
export interface ButterTokenInfo {
  /** The chain on which this token identifier is valid. */
  chainId?: string | number
  /** The preferred token address returned by Butter. */
  address?: string
  /** Alternate token identifier used by some Butter endpoints. */
  token?: string
  /** The preferred decimal precision field. */
  decimals?: number | string
  /** Alternate singular decimal precision field used by the token API. */
  decimal?: number | string
  /** The human-readable token ticker. */
  symbol?: string
  /** The optional human-readable token name. */
  name?: string
}

/** EVM transaction request passed to configured senders. */
export interface EvmTransactionRequest {
  /** The target address for the submitted EVM transaction. */
  to: `0x${string}` | string
  /** The native value in source-chain base units. */
  value?: bigint | undefined
  /** The transaction calldata. */
  data?: `0x${string}` | string | undefined
  /** The numeric EVM chain identifier. */
  chainId?: number | undefined
}

/** Internal cached route envelope. */
export interface CachedRoute {
  /** Deterministic request key used to match this route to caller options. */
  key: string
  /** The validated Butter route retained for quoting or execution. */
  route: ButterRoute
  /** Integer slippage sent to both `/route` and `/swap`. */
  slippageBps: number
  /**
   * Source-token decimals resolved by this package (config / `/findToken` / native
   * default) and used to build the request — NOT the route's own reported value.
   */
  sourceDecimals: number
  /** Unix timestamp after which this route cannot be reused. */
  expiresAt: number
}
