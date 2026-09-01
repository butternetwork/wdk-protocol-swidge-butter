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
 * Read-only probe: does Butter's `/route` actually accept `type=exactOut`, and in
 * which token is `amount` denominated when it does?
 *
 * This package rejects exact-out before any network request
 * (`ButterExactOutUnsupportedError`) for two reasons, both of which this script
 * re-checks against the live API rather than against documentation:
 *
 *  1. The default production endpoint has been observed rejecting `type=exactOut`
 *     with `errno 2000` ("Parameter error"), while the identical `exactIn` request
 *     succeeds.
 *  2. The `/route` docs describe `amount` only as "amount of source token", with no
 *     variant for exactOut — so even a working endpoint leaves the denomination
 *     unspecified, and sending the wrong side would misprice the trade.
 *
 * Sends no transaction and needs no funded account. If this reports that exactOut
 * succeeds AND settles which side `amount` refers to, re-enabling exact-out still
 * requires a fresh input-bound design and security review.
 */

import { butterAuthFromEnv, envOrDefault, printJson, runExample } from './shared.js'

const ROUTER_BASE_URL = 'https://bs-router-v3.chainservice.io/'

interface RouteEnvelope {
  errno?: number
  message?: string
  data?: unknown
}

async function requestRoute (params: Record<string, string>): Promise<RouteEnvelope> {
  const auth = butterAuthFromEnv()
  const url = new URL('route', envOrDefault('BUTTER_ROUTER_BASE_URL', ROUTER_BASE_URL))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const headers: Record<string, string> = {}
  if (auth.apiKeyId) headers['x-api-key-id'] = auth.apiKeyId
  if (auth.apiSecret) headers.Authorization = `Bearer ${auth.apiSecret}`

  const response = await fetch(url.toString(), { method: 'GET', headers })
  if (!response.ok) {
    return { errno: -1, message: `HTTP ${response.status}` }
  }
  return await response.json() as RouteEnvelope
}

function summarize (envelope: RouteEnvelope): { accepted: boolean, errno: number | undefined, message: string | undefined, tradeType?: unknown, totalAmountIn?: unknown, totalAmountOut?: unknown } {
  const route = Array.isArray(envelope.data) ? envelope.data[0] : undefined
  const chain = (route as { srcChain?: Record<string, unknown>, dstChain?: Record<string, unknown> } | undefined)
  return {
    accepted: envelope.errno === 0,
    errno: envelope.errno,
    message: envelope.message,
    tradeType: (route as { tradeType?: unknown } | undefined)?.tradeType,
    // When exactOut is accepted, these decide the open question: if the echoed
    // input matches the `amount` sent, `amount` is source-denominated (and exactOut
    // is meaningless); if the echoed OUTPUT matches it, `amount` is destination-
    // denominated and exact-out behaves as WDK expects.
    totalAmountIn: chain?.srcChain?.totalAmountIn,
    totalAmountOut: chain?.dstChain?.totalAmountOut ?? chain?.srcChain?.totalAmountOut
  }
}

runExample(async () => {
  // Defaults: 10 USDT out (or in) on BNB Smart Chain, same-chain USDT->USDC.
  const shared = {
    fromChainId: envOrDefault('PROBE_FROM_CHAIN', '56'),
    toChainId: envOrDefault('PROBE_TO_CHAIN', '56'),
    tokenInAddress: envOrDefault('PROBE_TOKEN_IN', '0x55d398326f99059fF775485246999027B3197955'),
    tokenOutAddress: envOrDefault('PROBE_TOKEN_OUT', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
    amount: envOrDefault('PROBE_AMOUNT', '10'),
    slippage: envOrDefault('PROBE_SLIPPAGE', '100'),
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk')
  }

  const exactIn = summarize(await requestRoute({ ...shared, type: 'exactIn' }))
  const exactOut = summarize(await requestRoute({ ...shared, type: 'exactOut' }))

  printJson({
    request: shared,
    exactIn,
    exactOut,
    // The control matters: an exactOut failure only means something if the same
    // request succeeds as exactIn. Otherwise the pair, the chain, or the
    // credentials are the problem, not the swap type.
    verdict: !exactIn.accepted
      ? 'INCONCLUSIVE — the exactIn control also failed; fix the request before reading the exactOut result'
      : exactOut.accepted
        ? `exactOut ACCEPTED — compare amount=${shared.amount} against totalAmountIn/totalAmountOut above to settle which side it denominates, then re-enable exact-out`
        : `exactOut REJECTED (errno ${String(exactOut.errno)}) — the current ButterExactOutUnsupportedError behavior is correct`
  })
})
