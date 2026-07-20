export const DEFAULT_ROUTER_BASE_URL = 'https://bs-router-v3.chainservice.io'
export const DEFAULT_TOKEN_BASE_URL = 'https://bs-tokens-api.chainservice.io'
export const DEFAULT_APP_BASE_URL = 'https://bs-app-api.chainservice.io'

export const ROUTE_TTL_SECONDS = 300
export const ROUTE_EXPIRY_MARGIN_SECONDS = 15
export const DEFAULT_SLIPPAGE_BPS = 100
export const CROSS_CHAIN_MIN_SLIPPAGE_BPS = 150
export const STRICT_CHAIN_MIN_SLIPPAGE_BPS = 300

export const BTC_CHAIN_ID = '1360095883558913'
export const SOLANA_CHAIN_ID = '1360108768460801'
export const TRON_CHAIN_ID = '728126428'

export const NATIVE_TOKEN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
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
