/**
 * Normalizes an on-chain identifier for comparison or use as a map key.
 *
 * Lowercases **only** confirmed EVM hex. Everything else is returned trimmed but
 * otherwise untouched, because there is no safe case transformation for an opaque
 * identifier. Note this is for addresses and hashes, not for human-readable fields:
 * token symbols, chain names and status strings are legitimately case-insensitive
 * and are compared with plain `toLowerCase()` at their own sites.
 */
export declare function normalizeIdentifier(value: string): string;
/**
 * True when two on-chain identifiers denote the same thing.
 *
 * An absent or empty identifier never matches — including against another absent
 * one, since "we do not know which token this is" is not evidence that two unknowns
 * are the same token.
 */
export declare function sameIdentifier(left: string | undefined, right: string | undefined): boolean;
/**
 * Normalizes a token identifier inside one chain's format space.
 *
 * Ordinary Solana/Base58 identifiers remain exact. Tron is the exceptional chain:
 * Butter mixes Base58Check, Tron `41`-prefixed hex, and an EVM-shaped `0x` form for
 * the same account, so valid representations are reduced to the 20-byte account id.
 * Native aliases are also reduced to a chain-scoped key, preventing `sol` on an EVM
 * chain (or `btc` on Solana) from being mistaken for that chain's native asset.
 */
export declare function normalizeTokenIdentifier(chainId: string | number, value: string): string;
/** True when two token identifiers denote the same token on the named chain. */
export declare function sameTokenIdentifier(chainId: string | number, left: string | undefined, right: string | undefined): boolean;
/** True when the identifier denotes the named chain's native asset. */
export declare function isNativeTokenIdentifier(chainId: string | number, token: string): boolean;
/**
 * True only for a textual native alias, never for an address-shaped sentinel.
 * Fee-component symbol fallback uses this narrower rule by design.
 */
export declare function isSymbolicNativeTokenIdentifier(chainId: string | number, token: string): boolean;
/** Returns the representation Butter expects when the caller used a native alias. */
export declare function toButterTokenIdentifier(chainId: string | number, token: string): string;
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
export declare function normalizeTransactionHash(value: string): string;
/** True when two transaction hashes denote the same transaction. */
export declare function sameTransactionHash(left: string | undefined, right: string | undefined): boolean;
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
export declare function normalizeTokenKey(chainId: string | number, token: string): string;
//# sourceMappingURL=identifiers.d.ts.map