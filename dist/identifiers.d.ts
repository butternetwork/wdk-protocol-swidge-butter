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
 * Key for a `tokenDecimals` entry, used for BOTH building the map and querying it.
 *
 * Sharing one named function is the whole point: normalizing only the query left a
 * checksummed configuration key unreachable by the equivalent lowercase request, so
 * configured decimals were reported missing. It follows the identifier rule, so an
 * EVM address is case-insensitive and a Base58 mint is not.
 *
 * There is deliberately no case for the symbolic native ids (`btc`, `sol`, …): those
 * never reach a `tokenDecimals` lookup, because `route.ts: decimalsFor` answers them
 * from `NATIVE_TOKEN_ADDRESSES` and `config.nativeTokenDecimals` first. Configure a
 * native token's decimals there, not here.
 */
export declare function normalizeTokenKey(token: string): string;
//# sourceMappingURL=identifiers.d.ts.map