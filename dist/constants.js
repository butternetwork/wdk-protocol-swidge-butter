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
export const DEFAULT_ROUTER_BASE_URL = 'https://bs-router-v3.chainservice.io';
export const DEFAULT_TOKEN_BASE_URL = 'https://bs-tokens-api.chainservice.io';
export const DEFAULT_APP_BASE_URL = 'https://bs-app-api.chainservice.io';
export const ROUTE_TTL_SECONDS = 300;
export const ROUTE_EXPIRY_MARGIN_SECONDS = 15;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const CROSS_CHAIN_MIN_SLIPPAGE_BPS = 150;
export const STRICT_CHAIN_MIN_SLIPPAGE_BPS = 300;
export const BTC_CHAIN_ID = '1360095883558913';
export const SOLANA_CHAIN_ID = '1360108768460801';
export const TRON_CHAIN_ID = '728126428';
// Butter's SDK chain ID for TON. Not currently advertised by
// /supportedChainInfo; kept so the 300 bps strict-slippage floor applies
// without requiring a prior getSupportedChains() call if TON routing returns.
export const TON_CHAIN_ID = '1360104473493505';
export const NATIVE_TOKEN_ADDRESSES = new Set([
    '0x0000000000000000000000000000000000000000',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'native',
    'btc',
    'ton',
    'trx',
    'sol'
]);
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
};
//# sourceMappingURL=constants.js.map