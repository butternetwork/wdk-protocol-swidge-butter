export declare const DEFAULT_ROUTER_BASE_URL = "https://bs-router-v3.chainservice.io";
export declare const DEFAULT_TOKEN_BASE_URL = "https://bs-tokens-api.chainservice.io";
export declare const DEFAULT_APP_BASE_URL = "https://bs-app-api.chainservice.io";
export declare const ROUTE_TTL_SECONDS = 300;
export declare const ROUTE_EXPIRY_MARGIN_SECONDS = 15;
/** Maximum number of cached routes retained by a long-lived instance. */
export declare const ROUTE_CACHE_MAX_ENTRIES = 256;
/** Maximum number of executed operation kinds remembered for status routing. */
export declare const OPERATION_KIND_MAX_ENTRIES = 1024;
/** Butter router `errno` returned by `/findToken` when a token is unknown. */
export declare const TOKEN_NOT_FOUND_ERRNO = 2002;
export declare const DEFAULT_SLIPPAGE_BPS = 100;
export declare const CROSS_CHAIN_MIN_SLIPPAGE_BPS = 150;
export declare const STRICT_CHAIN_MIN_SLIPPAGE_BPS = 300;
export declare const BTC_CHAIN_ID = "1360095883558913";
export declare const SOLANA_CHAIN_ID = "1360108768460801";
export declare const TRON_CHAIN_ID = "728126428";
export declare const TON_CHAIN_ID = "1360104473493505";
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