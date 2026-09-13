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

import { envOrDefault, printJson, requestButterRoute, runExample } from './shared.js'

interface FeePart { amount?: string, token?: { address?: string, symbol?: string, decimals?: number } }

interface RouteEnvelope {
  errno?: number
  message?: string
  data?: Array<{
    bridgeFee?: FeePart & { chainId?: string | number, symbol?: string, address?: string, in?: FeePart, out?: FeePart, affiliate?: FeePart }
    swapFee?: { nativeFee?: string, tokenFee?: string }
    feeConfig?: { feeType?: number | string, referrer?: string, rateOrNativeFee?: string | number }
  }>
}

runExample(async () => {
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
  // The actual affiliate charge is included in swapFee; feeConfig is calldata metadata.
  const affiliate = envOrDefault('PROBE_AFFILIATE', '')
  if (affiliate) params.affiliate = affiliate

  const envelope = await requestButterRoute<RouteEnvelope>(params)
  if (envelope.errno !== 0) throw new Error(`Butter /route failed: errno ${String(envelope.errno)} ${envelope.message ?? ''}`)

  const route = envelope.data?.[0]
  const bridgeFee = route?.bridgeFee

  printJson({
    request: params,
    bridgeFee,
    // Compare the referrer configuration with Butter's authoritative actual fee.
    // Fee mapping and capping use swapFee only; feeConfig validates calldata.
    feeConfig: route?.feeConfig,
    swapFee: route?.swapFee
  })
})
