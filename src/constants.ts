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

export const DEFAULT_ROUTER_BASE_URL = 'https://bs-router-v3.chainservice.io'
export const DEFAULT_TOKEN_BASE_URL = 'https://bs-tokens-api.chainservice.io'
export const DEFAULT_APP_BASE_URL = 'https://bs-app-api.chainservice.io'

export const ROUTE_TTL_SECONDS = 300
/**
 * Freshness margin required to reuse a cached route on the **quote** path.
 * A quote is non-binding and the caller can re-ask at any time, so this only
 * avoids handing back a route that is about to expire.
 */
export const ROUTE_EXPIRY_MARGIN_SECONDS = 15
/**
 * Freshness margin required to use a route on the **execution** path.
 *
 * Execution still has to complete a `/swap` round-trip, an optional ERC-20
 * approval (whose receipt wait defaults to 60s), and the swap send before the
 * quote has to still be good on-chain — so it needs a far larger margin than a
 * quote does. Configurable via `routeExecutionMarginSeconds`, which should
 * exceed `evm.approvalTimeoutMs / 1000` when approvals are expected.
 */
export const ROUTE_EXECUTION_MARGIN_SECONDS = 45
/** Maximum number of cached routes retained by a long-lived instance. */
export const ROUTE_CACHE_MAX_ENTRIES = 256
/** Maximum number of executed operation kinds remembered for status routing. */
export const OPERATION_KIND_MAX_ENTRIES = 1024
/** Butter router `errno` returned by `/findToken` when a token is unknown. */
export const TOKEN_NOT_FOUND_ERRNO = 2002
/**
 * Upward drift tolerated between the native fee `/route` quotes and the one
 * `/swap` encodes in `tx.value`. The two are formatted independently (decimal
 * string vs hex integer), so exact equality would fail on a 1 wei round-trip.
 * This is a sanity check, not a security boundary — `maxNativeFee` is the cap
 * that actually bounds native spend.
 */
export const NATIVE_FEE_DRIFT_BPS = 50

export const DEFAULT_SLIPPAGE_BPS = 100
export const CROSS_CHAIN_MIN_SLIPPAGE_BPS = 150
export const STRICT_CHAIN_MIN_SLIPPAGE_BPS = 300

export const BTC_CHAIN_ID = '1360095883558913'
export const SOLANA_CHAIN_ID = '1360108768460801'
export const TRON_CHAIN_ID = '728126428'
// Butter's SDK chain ID for TON. Not currently advertised by
// /supportedChainInfo; kept so the 300 bps strict-slippage floor applies
// without requiring a prior getSupportedChains() call if TON routing returns.
export const TON_CHAIN_ID = '1360104473493505'

/**
 * Address family per non-EVM chain, used to decide whether the source sender is
 * a usable default recipient on the destination chain.
 *
 * Deliberately keyed off the chain-id constants above rather than
 * `SwidgeSupportedChain.type`: reading that would require a discovery round-trip
 * inside `swidge`, and Butter does not always report a chain type.
 *
 * This is a **best-effort** table, not a complete taxonomy. A chain in neither
 * this map nor {@link KNOWN_EVM_CHAIN_IDS} resolves to `'unknown'`, NOT to `'evm'`:
 * Butter's supported-chain list changes without this package being republished, so
 * assuming EVM would silently reuse a `0x` sender as the destination receiver on a
 * newly added non-EVM chain — funds delivered to an address nobody can spend. When
 * Butter adds a chain, add it to the appropriate table here.
 */
export const NON_EVM_CHAIN_FAMILIES: ReadonlyMap<string, string> = new Map([
  [BTC_CHAIN_ID, 'utxo'],
  [SOLANA_CHAIN_ID, 'svm'],
  [TRON_CHAIN_ID, 'tvm'],
  [TON_CHAIN_ID, 'ton']
])

/**
 * EVM chains this package recognizes by id, for the address-family check only.
 *
 * Broader than the Router registry on purpose: a *destination* chain needs no
 * Router entry here, so pinning the family to executable chains would demand an
 * explicit recipient for ordinary EVM-to-EVM routes. Extend via
 * `config.evmChainIds` rather than editing this list downstream.
 */
export const KNOWN_EVM_CHAIN_IDS: ReadonlySet<string> = new Set([
  '1', // Ethereum
  '10', // OP Mainnet
  '56', // BNB Smart Chain
  '100', // Gnosis
  '130', // Unichain
  '137', // Polygon
  '196', // X Layer
  '199', // BitTorrent Chain
  '324', // zkSync Era
  '1101', // Polygon zkEVM
  '5000', // Mantle
  '8453', // Base
  '22776', // MAP Protocol
  '34443', // Mode
  '42161', // Arbitrum One
  '43114', // Avalanche C-Chain
  '59144', // Linea
  '81457', // Blast
  '534352' // Scroll
])

/**
 * Resolves a chain's address family, or `'unknown'` when neither table lists it.
 *
 * `'unknown'` is deliberately not `'evm'`: see {@link NON_EVM_CHAIN_FAMILIES}.
 * Callers must treat it as "cannot default the recipient", never as a family that
 * happens to match the source.
 */
export function addressFamilyForChain (chainId: string, extraEvmChainIds?: ReadonlySet<string>): string {
  const nonEvm = NON_EVM_CHAIN_FAMILIES.get(chainId)
  if (nonEvm != null) return nonEvm
  if (KNOWN_EVM_CHAIN_IDS.has(chainId) || extraEvmChainIds?.has(chainId) === true) return 'evm'
  return 'unknown'
}

export const NATIVE_TOKEN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'native',
  'btc',
  'ton',
  'trx',
  'sol'
])

/**
 * The subset of {@link NATIVE_TOKEN_ADDRESSES} that are **symbols rather than
 * addresses** — i.e. every member except the two EVM native sentinels.
 *
 * These are the only source-token identifiers a fee component may be matched to by
 * symbol. Any other identifier is an address of some kind (EVM hex, Solana mint,
 * Tron base58), and matching those by symbol would let a response name the source
 * token in its `symbol` field and be taken for it. Deliberately a closed set rather
 * than a shape test: `0x`-prefix detection would treat a Solana mint as symbolic and
 * reopen exactly that hole.
 */
export const SYMBOLIC_NATIVE_TOKEN_IDS: ReadonlySet<string> = new Set([
  'native',
  'btc',
  'ton',
  'trx',
  'sol'
])

export const DEFAULT_ROUTER_CONTRACTS = {
  '1': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '10': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '56': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '130': [{ address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' }],
  '137': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '196': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '8453': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '42161': [
    { address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' },
    { address: '0xEE030ec6F4307411607E55aCD08e628Ae6655B86', version: 'v3' }
  ],
  '43114': [{ address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' }],
  '59144': [{ address: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A', version: 'v3' }]
} as const
