export declare const DEFAULT_ROUTER_BASE_URL = "https://bs-router-v3.chainservice.io";
export declare const DEFAULT_TOKEN_BASE_URL = "https://bs-tokens-api.chainservice.io";
export declare const DEFAULT_APP_BASE_URL = "https://bs-app-api.chainservice.io";
export declare const ROUTE_TTL_SECONDS = 300;
/**
 * Freshness margin required to reuse a cached route on the **quote** path.
 * A quote is non-binding and the caller can re-ask at any time, so this only
 * avoids handing back a route that is about to expire.
 */
export declare const ROUTE_EXPIRY_MARGIN_SECONDS = 15;
/**
 * Freshness margin required to use a route on the **execution** path.
 *
 * Execution still has to complete a `/swap` round-trip, an optional ERC-20
 * approval (whose receipt wait defaults to 60s), and the swap send before the
 * quote has to still be good on-chain — so it needs a far larger margin than a
 * quote does. Configurable via `routeExecutionMarginSeconds`, which should
 * exceed `evm.approvalTimeoutMs / 1000` when approvals are expected.
 */
export declare const ROUTE_EXECUTION_MARGIN_SECONDS = 45;
/** Maximum number of cached routes retained by a long-lived instance. */
export declare const ROUTE_CACHE_MAX_ENTRIES = 256;
/** Maximum number of executed operation kinds remembered for status routing. */
export declare const OPERATION_KIND_MAX_ENTRIES = 1024;
/** Butter router `errno` returned by `/findToken` when a token is unknown. */
export declare const TOKEN_NOT_FOUND_ERRNO = 2002;
/**
 * Upward drift tolerated between the native fee `/route` quotes and the one
 * `/swap` encodes in `tx.value`. The two are formatted independently (decimal
 * string vs hex integer), so exact equality would fail on a 1 wei round-trip.
 * This is a sanity check, not a security boundary — `maxNativeFee` is the cap
 * that actually bounds native spend.
 */
export declare const NATIVE_FEE_DRIFT_BPS = 50;
export declare const DEFAULT_SLIPPAGE_BPS = 100;
export declare const CROSS_CHAIN_MIN_SLIPPAGE_BPS = 150;
export declare const STRICT_CHAIN_MIN_SLIPPAGE_BPS = 300;
export declare const BTC_CHAIN_ID = "1360095883558913";
export declare const SOLANA_CHAIN_ID = "1360108768460801";
export declare const TRON_CHAIN_ID = "728126428";
export declare const TON_CHAIN_ID = "1360104473493505";
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
export declare const NON_EVM_CHAIN_FAMILIES: ReadonlyMap<string, string>;
/**
 * EVM chains this package recognizes by id, for the address-family check only.
 *
 * Broader than the Router registry on purpose: a *destination* chain needs no
 * Router entry here, so pinning the family to executable chains would demand an
 * explicit recipient for ordinary EVM-to-EVM routes. Extend via
 * `config.evmChainIds` rather than editing this list downstream.
 */
export declare const KNOWN_EVM_CHAIN_IDS: ReadonlySet<string>;
/**
 * Resolves a chain's address family, or `'unknown'` when neither table lists it.
 *
 * `'unknown'` is deliberately not `'evm'`: see {@link NON_EVM_CHAIN_FAMILIES}.
 * Callers must treat it as "cannot default the recipient", never as a family that
 * happens to match the source.
 */
export declare function addressFamilyForChain(chainId: string, extraEvmChainIds?: ReadonlySet<string>): string;
export declare const NATIVE_TOKEN_ADDRESSES: Set<string>;
export declare const DEFAULT_ROUTER_CONTRACTS: {
    readonly '1': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '10': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '56': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '130': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }];
    readonly '137': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '196': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '8453': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '42161': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }, {
        readonly address: "0xEE030ec6F4307411607E55aCD08e628Ae6655B86";
        readonly version: "v3";
    }];
    readonly '43114': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }];
    readonly '59144': readonly [{
        readonly address: "0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A";
        readonly version: "v3";
    }];
};
//# sourceMappingURL=constants.d.ts.map