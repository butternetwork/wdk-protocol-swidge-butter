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

/**
 * Read-only probe: is `bridgeFee.amount` the sum of `bridgeFee.in` and
 * `bridgeFee.out`, or just a restatement of `out`?
 *
 * Butter's `/route` documentation describes `in` and `out` only as "input/output
 * token details" and never says how they relate to the top-level `amount`. Its
 * published example has `in.amount: "0.0"` with `out.amount === amount`, which is
 * consistent with both readings.
 *
 * This is **not** a release gate. `fees.ts: bridgeFeeComponents` prices the
 * components and ignores the summary, which cannot under-report under either
 * reading: if the summary is a sum, `in + out` equals it; if it only mirrors `out`,
 * `in + out` is the more complete figure. Settling the question just lets the
 * summary fallback be deleted, and reveals whether Butter ever charges on both
 * sides at once in different tokens.
 *
 * Sends no transaction and needs no funded account. Prefer a cross-chain pair: a
 * same-chain route has no bridge leg and so no bridge fee to inspect.
 */

import { butterAuthFromEnv, envOrDefault, printJson, runExample } from './shared.js'

const ROUTER_BASE_URL = 'https://bs-router-v3.chainservice.io/'

interface FeePart { amount?: string, token?: { address?: string, symbol?: string, decimals?: number } }

interface RouteEnvelope {
  errno?: number
  message?: string
  data?: Array<{
    bridgeFee?: FeePart & { symbol?: string, address?: string, in?: FeePart, out?: FeePart, affiliate?: FeePart }
    swapFee?: { nativeFee?: string, tokenFee?: string }
    feeConfig?: { feeType?: number | string, referrer?: string, rateOrNativeFee?: string | number }
  }>
}

/**
 * Compares `amount` with `in + out` as decimal strings scaled to a common power of
 * ten, so a float round-trip cannot decide the verdict.
 */
function comparison (amount: string | undefined, inAmount: string | undefined, outAmount: string | undefined): string {
  if (amount == null) return 'no top-level amount reported'
  const scale = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.trim().split('.')
    return BigInt(whole + fraction.padEnd(30, '0').slice(0, 30))
  }
  try {
    const total = scale(amount)
    const parts = scale(inAmount ?? '0') + scale(outAmount ?? '0')
    if (total === parts) return 'amount === in + out (summary is a SUM)'
    if (total === scale(outAmount ?? '0')) return 'amount === out (summary MIRRORS out; a non-zero `in` would be missed by any code reading only the summary)'
    return `amount (${amount}) matches neither in + out nor out alone — inspect manually`
  } catch {
    return 'amounts are not plain decimal strings — inspect manually'
  }
}

runExample(async () => {
  const auth = butterAuthFromEnv()
  const params: Record<string, string> = {
    // Default to a cross-chain pair: same-chain routes have no bridge fee at all.
    fromChainId: envOrDefault('PROBE_FROM_CHAIN', '56'),
    toChainId: envOrDefault('PROBE_TO_CHAIN', '137'),
    tokenInAddress: envOrDefault('PROBE_TOKEN_IN', '0x55d398326f99059fF775485246999027B3197955'),
    tokenOutAddress: envOrDefault('PROBE_TOKEN_OUT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'),
    amount: envOrDefault('PROBE_AMOUNT', '10'),
    type: 'exactIn',
    slippage: envOrDefault('PROBE_SLIPPAGE', '300'),
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk')
  }
  // Optional: pass an affiliate to make Butter populate a non-zero feeConfig, which
  // is what the fee-cap check now values.
  const affiliate = envOrDefault('PROBE_AFFILIATE', '')
  if (affiliate) params.affiliate = affiliate

  const url = new URL('route', envOrDefault('BUTTER_ROUTER_BASE_URL', ROUTER_BASE_URL))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const headers: Record<string, string> = {}
  if (auth.apiKeyId) headers['x-api-key-id'] = auth.apiKeyId
  if (auth.apiSecret) headers.Authorization = `Bearer ${auth.apiSecret}`

  const response = await fetch(url.toString(), { method: 'GET', headers })
  if (!response.ok) throw new Error(`Butter /route failed with HTTP ${response.status}`)
  const envelope = await response.json() as RouteEnvelope
  if (envelope.errno !== 0) throw new Error(`Butter /route failed: errno ${String(envelope.errno)} ${envelope.message ?? ''}`)

  const route = envelope.data?.[0]
  const bridgeFee = route?.bridgeFee

  printJson({
    request: params,
    bridgeFee: {
      amount: bridgeFee?.amount,
      symbol: bridgeFee?.symbol,
      in: { amount: bridgeFee?.in?.amount, token: bridgeFee?.in?.token?.symbol },
      out: { amount: bridgeFee?.out?.amount, token: bridgeFee?.out?.token?.symbol },
      affiliate: { amount: bridgeFee?.affiliate?.amount, token: bridgeFee?.affiliate?.token?.symbol }
    },
    // Do in and out ever use different tokens? If so, no single entry could have
    // reported this fee honestly, which is why they are now priced separately.
    componentsShareOneToken: bridgeFee?.in?.token?.symbol == null || bridgeFee?.out?.token?.symbol == null
      ? 'only one component present'
      : String(bridgeFee.in.token.symbol === bridgeFee.out.token.symbol),
    verdict: comparison(bridgeFee?.amount, bridgeFee?.in?.amount, bridgeFee?.out?.amount),
    // Shown because the protocol fee cap now values feeConfig directly: feeType 1
    // means rateOrNativeFee is bps of the input, feeType 0 means source-chain wei.
    feeConfig: route?.feeConfig,
    swapFee: route?.swapFee
  })
})
