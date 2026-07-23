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
  SwidgeSupportedTokensOptions
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
  SwidgeSupportedTokensOptions
}

/**
 * Structural subset of a WDK wallet account used by the Butter provider.
 *
 * Mirrors `IWalletAccountReadOnly` / `IWalletAccount` from `@tetherto/wdk-wallet`:
 * read-only accounts expose {@link getAddress} and {@link getTransactionReceipt},
 * while full accounts additionally expose {@link sendTransaction}. Execution
 * requires a full account (or an explicit `evm.*` sender override).
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

/** Read-only EVM client capabilities needed for allowance checks. */
export interface EvmPublicClient {
  readContract: (args: unknown) => Promise<bigint>
  waitForTransactionReceipt?: (args: { hash: string, confirmations?: number, timeout?: number }) => Promise<unknown>
}

/** EVM wallet client capabilities needed for transaction submission. */
export interface EvmWalletClient {
  account?: { address: string }
  sendTransaction: (args: unknown) => Promise<string | { hash?: string }>
}

/** Converts Butter transaction data for a non-viem execution environment. */
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
    /** Optional viem-style wallet client overriding account-based sending. */
    walletClient?: EvmWalletClient
    /** Optional raw sender overriding both the wallet client and the account. */
    sendTransaction?: (tx: EvmTransactionRequest) => Promise<string | { hash?: string }>
    approvalAmount?: 'exact' | 'max'
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

/** Per-chain route segment returned by Butter. */
export interface ButterRouteChain {
  chainId?: string | number
  tokenIn?: ButterRouteToken
  tokenOut?: ButterRouteToken
  totalAmountIn?: string
  totalAmountOut?: string
  totalAmountInUSD?: string
  totalAmountOutUSD?: string
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
