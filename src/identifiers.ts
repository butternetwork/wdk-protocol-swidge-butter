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

import { base58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  BTC_CHAIN_ID,
  SOLANA_CHAIN_ID,
  SYMBOLIC_NATIVE_TOKEN_IDS,
  TRON_CHAIN_ID
} from './constants.js'

/**
 * Chain-format-aware comparison for token addresses, transaction hashes, and any
 * other opaque on-chain identifier.
 *
 * **Case-insensitivity is a property of EVM hex, not of identifiers in general.** An
 * EVM address or transaction hash is hex, and EIP-55 mixed casing is a checksum laid
 * over it, so `0xAbCd…` and `0xabcd…` name the same thing. Nothing else in this
 * package's world works that way: Solana mints and signatures and Tron Base58Check
 * addresses encode information in each character's case, so `AbCd…` and `abcd…`
 * are different values. Chain-specific equivalent encodings are handled separately
 * by {@link normalizeTokenIdentifier}; this generic function never guesses a chain.
 *
 * Lowercasing everything therefore silently merges distinct non-EVM identifiers.
 * That had teeth: a bridge fee charged in one Solana mint was accepted as the
 * caller's source token because the two differed only in case, which handed it the
 * caller's own input as a fee denominator and let it pass a bps cap; a `/route`
 * response could satisfy the token-intent check with a differently cased token; two
 * distinct mints collapsed into one entry in discovery and shared a decimals cache
 * slot; and two different Solana signatures were treated as the same operation.
 */

/** An EVM address or transaction hash: hex, where casing is only an EIP-55 checksum. */
const EVM_HEX = /^0x[0-9a-fA-F]+$/

/**
 * A Bitcoin or Tron transaction id: 64 hex characters with no prefix.
 *
 * Length 64 is what makes this unambiguous against Base58. A Solana signature is 87
 * or 88 base58 characters and a Solana address 32 to 44, so neither can be mistaken
 * for a bare 64-character hex string, and hex is case-insensitive by nature.
 */
const BARE_HEX_TX_HASH = /^[0-9a-fA-F]{64}$/

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const SOLANA_NATIVE_TOKEN = 'So11111111111111111111111111111111111111112'
const TRON_NATIVE_TOKEN = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const TRON_ADDRESS_PREFIX = 0x41
const TRON_BASE58CHECK = base58check(sha256)

const CHAIN_NATIVE_SYMBOL = new Map<string, string>([
  [BTC_CHAIN_ID, 'btc'],
  [SOLANA_CHAIN_ID, 'sol'],
  [TRON_CHAIN_ID, 'trx']
])

/**
 * Normalizes an on-chain identifier for comparison or use as a map key.
 *
 * Lowercases **only** confirmed EVM hex. Everything else is returned trimmed but
 * otherwise untouched, because there is no safe case transformation for an opaque
 * identifier. Note this is for addresses and hashes, not for human-readable fields:
 * token symbols, chain names and status strings are legitimately case-insensitive
 * and are compared with plain `toLowerCase()` at their own sites.
 */
export function normalizeIdentifier (value: string): string {
  const trimmed = value.trim()
  return EVM_HEX.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * True when two on-chain identifiers denote the same thing.
 *
 * An absent or empty identifier never matches — including against another absent
 * one, since "we do not know which token this is" is not evidence that two unknowns
 * are the same token.
 */
export function sameIdentifier (left: string | undefined, right: string | undefined): boolean {
  return sameUnder(normalizeIdentifier, left, right)
}

/**
 * Normalizes a token identifier inside one chain's format space.
 *
 * Ordinary Solana/Base58 identifiers remain exact. Tron is the exceptional chain:
 * Butter mixes Base58Check, Tron `41`-prefixed hex, and an EVM-shaped `0x` form for
 * the same account, so valid representations are reduced to the 20-byte account id.
 * Native aliases are also reduced to a chain-scoped key, preventing `sol` on an EVM
 * chain (or `btc` on Solana) from being mistaken for that chain's native asset.
 */
export function normalizeTokenIdentifier (chainId: string | number, value: string): string {
  const chain = String(chainId)
  const trimmed = value.trim()
  if (!trimmed) return ''
  const lowered = trimmed.toLowerCase()
  if (lowered === 'native' || lowered === ZERO_ADDRESS || lowered === NATIVE_SENTINEL) return `native:${chain}`
  if (lowered === CHAIN_NATIVE_SYMBOL.get(chain)) return `native:${chain}`
  if (chain === SOLANA_CHAIN_ID && trimmed === SOLANA_NATIVE_TOKEN) return `native:${chain}`
  if (chain === TRON_CHAIN_ID) {
    const account = tronAccountId(trimmed)
    if (account === ZERO_ADDRESS.slice(2)) return `native:${chain}`
    if (account != null) return `tron:${account}`
  }
  return normalizeIdentifier(trimmed)
}

/** True when two token identifiers denote the same token on the named chain. */
export function sameTokenIdentifier (
  chainId: string | number,
  left: string | undefined,
  right: string | undefined
): boolean {
  return sameUnder((value) => normalizeTokenIdentifier(chainId, value), left, right)
}

/** True when the identifier denotes the named chain's native asset. */
export function isNativeTokenIdentifier (chainId: string | number, token: string): boolean {
  const chain = String(chainId)
  return normalizeTokenIdentifier(chain, token) === `native:${chain}`
}

/**
 * True only for a textual native alias, never for an address-shaped sentinel.
 * Fee-component symbol fallback uses this narrower rule by design.
 */
export function isSymbolicNativeTokenIdentifier (chainId: string | number, token: string): boolean {
  const lowered = token.trim().toLowerCase()
  if (!SYMBOLIC_NATIVE_TOKEN_IDS.has(lowered)) return false
  return lowered === 'native' || lowered === CHAIN_NATIVE_SYMBOL.get(String(chainId))
}

/** Returns the representation Butter expects when the caller used a native alias. */
export function toButterTokenIdentifier (chainId: string | number, token: string): string {
  const chain = String(chainId)
  const trimmed = token.trim()
  if (normalizeTokenIdentifier(chain, trimmed) !== `native:${chain}`) return trimmed
  if (chain === SOLANA_CHAIN_ID) return SOLANA_NATIVE_TOKEN
  if (chain === TRON_CHAIN_ID) return TRON_NATIVE_TOKEN
  if (chain === BTC_CHAIN_ID) return ZERO_ADDRESS
  return trimmed
}

/**
 * Normalizes a **transaction hash**, which is a different format space from a token
 * identifier and so needs its own rule.
 *
 * Same as {@link normalizeIdentifier} plus bare 64-character hex, because Bitcoin
 * and Tron transaction ids carry no `0x` prefix and hex is case-insensitive
 * regardless. Token identifiers never take that shape, which is why the two domains
 * are separate functions rather than one permissive test: using the token rule on a
 * hash rejected a BTC txid that differed only in case, and using the hash rule on a
 * token identifier would start normalizing things it must not touch.
 *
 * Base58 signatures remain exact — see {@link BARE_HEX_TX_HASH} for why 64 is the
 * length that keeps them out.
 */
export function normalizeTransactionHash (value: string): string {
  const trimmed = value.trim()
  if (EVM_HEX.test(trimmed) || BARE_HEX_TX_HASH.test(trimmed)) return trimmed.toLowerCase()
  return trimmed
}

/** True when two transaction hashes denote the same transaction. */
export function sameTransactionHash (left: string | undefined, right: string | undefined): boolean {
  return sameUnder(normalizeTransactionHash, left, right)
}

function sameUnder (
  normalize: (value: string) => string,
  left: string | undefined,
  right: string | undefined
): boolean {
  if (left == null || right == null) return false
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  if (!normalizedLeft || !normalizedRight) return false
  return normalizedLeft === normalizedRight
}

/**
 * Chain-scoped key for a `tokenDecimals` entry, used for BOTH building the map and
 * querying it.
 *
 * Sharing one named function is the whole point: normalizing only the query left a
 * checksummed configuration key unreachable by the equivalent lowercase request, so
 * configured decimals were reported missing. It follows the identifier rule, so an
 * EVM address is case-insensitive and a Base58 mint is not.
 *
 * Symbolic native ids never reach a `tokenDecimals` lookup, because
 * `route.ts: decimalsFor` answers chain-valid aliases from
 * `config.nativeTokenDecimals` first. Configure a native token's decimals there,
 * not here.
 */
export function normalizeTokenKey (chainId: string | number, token: string): string {
  return normalizeTokenIdentifier(chainId, token)
}

function tronAccountId (token: string): string | undefined {
  const butterHex = /^0x([0-9a-fA-F]{40})$/.exec(token)
  if (butterHex?.[1]) return butterHex[1].toLowerCase()
  const tronHex = /^(?:0x)?41([0-9a-fA-F]{40})$/.exec(token)
  if (tronHex?.[1]) return tronHex[1].toLowerCase()
  try {
    const decoded = TRON_BASE58CHECK.decode(token)
    if (decoded.length !== 21 || decoded[0] !== TRON_ADDRESS_PREFIX) return undefined
    return bytesToHex(decoded.subarray(1))
  } catch {
    return undefined
  }
}
