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
 * Read-only probe for how Butter composes `bridgeFee`.
 *
 * This package depends on **no** relationship between the top-level `amount` and the
 * `in` / `out` / `affiliate` components. The summary is never priced, never
 * reconstructed from, and never even compared against the components: it is one
 * figure in one token describing a fee that can span three, so it is unattributable,
 * and amounts in different tokens cannot be added in the first place. It serves only
 * as a detector — a route reporting a summary with no components has the fee omitted
 * from `fees[]`, and a configured `maxProtocolFeeBps` refuses.
 *
 * What this script is for is seeing how a live route actually decomposes: which
 * components Butter populates, whether they ever span multiple tokens (the case that
 * makes any summary arithmetic meaningless), and how large the affiliate share is —
 * that share is charged to the user whether or not you configure `affiliate`, and it
 * counts toward `maxProtocolFeeBps`.
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
 * Checks `amount === in + out + affiliate`, comparing as integers scaled to a common
 * power of ten so a float round-trip cannot decide the verdict.
 */
function comparison (fee: { amount?: string, in?: FeePart, out?: FeePart, affiliate?: FeePart } | undefined): string {
  if (fee?.amount == null) return 'no top-level amount reported'
  const present = [fee.in, fee.out, fee.affiliate].filter((part) => part?.amount != null && Number(part.amount) !== 0)
  if (present.length === 0) return 'summary only, no components — fees.ts omits this fee and refuses a configured cap'
  // Amounts in different tokens are not addable. Summing them anyway is how an
  // inconsistent response comes to look consistent, so refuse instead of guessing.
  const tokens = new Set(present.map((part) => (part?.token?.address ?? part?.token?.symbol ?? '').toLowerCase()))
  if (tokens.size > 1) {
    return `components span ${tokens.size} tokens (${[...tokens].join(', ')}), so no sum against the single-token summary is meaningful — this is why fees.ts prices components individually and never the summary`
  }
  const scale = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.trim().split('.')
    return BigInt(whole + fraction.padEnd(30, '0').slice(0, 30))
  }
  try {
    const total = scale(fee.amount)
    const parts = scale(fee.in?.amount ?? '0') + scale(fee.out?.amount ?? '0') + scale(fee.affiliate?.amount ?? '0')
    if (total === parts) return 'amount === in + out + affiliate (single token, so the sum is meaningful)'
    return `amount (${fee.amount}) is not in + out + affiliate even though every component shares one token — worth reporting to Butter; fees.ts prices only the components, so this does not change what is charged`
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
    verdict: comparison(bridgeFee),
    // Compare the referrer configuration with Butter's authoritative actual fee.
    // Fee mapping and capping use swapFee only; feeConfig validates calldata.
    feeConfig: route?.feeConfig,
    swapFee: route?.swapFee
  })
})
