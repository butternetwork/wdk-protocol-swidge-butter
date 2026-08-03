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

import {
  NATIVE_TOKEN_ADDRESSES,
  SYMBOLIC_NATIVE_TOKEN_IDS,
  SOLANA_CHAIN_ID,
  BTC_CHAIN_ID,
  TRON_CHAIN_ID
} from './constants.js'
import { parseTokenAmount } from './amounts.js'
import { sameIdentifier } from './identifiers.js'
import {
  ButterApiError,
  ButterConfigurationError,
  ButterFeeLimitExceededError,
  ButterFeeValuationError
} from './errors.js'
import type {
  ButterBridgeFee,
  ButterFeePart,
  ButterRoute,
  ButterRouteToken,
  ButterWarning,
  SwidgeFee,
  SwidgeProtocolConfig
} from './types.js'

const USD_DECIMALS = 18
const BPS_DENOMINATOR = 10000n

/** Chain and token context required to parse Butter route fees. */
export interface FeeContext {
  sourceChainId: string
  sourceToken: string
  nativeTokenDecimals?: Record<string, number>
  /**
   * The caller's exact input in source-token base units. Used as the denominator
   * for source-denominated fee caps so an inflated route-reported input cannot
   * understate the ratio and bypass a bps limit. Required when a source-token
   * fee cap is enforced.
   */
  requestedAmountIn?: bigint
  /**
   * Exact-out only: the caller's `maxFromTokenAmount`, used as the denominator's
   * upper bound when {@link requestedAmountIn} cannot exist because the caller
   * named the output instead of the input.
   */
  maxAmountIn?: bigint
  /**
   * Source-token decimals this package resolved (config / `/findToken` / native
   * default) and used to build the `/route` request.
   *
   * Required whenever a source-denominated fee is measured against
   * {@link requestedAmountIn}: that denominator is in real base units, so parsing
   * the numerator with the route's own `srcChain.tokenIn.decimals` lets an
   * understated value shrink the fee by a power of ten and slip under a bps cap.
   * The route only has its token *address* checked, never its decimals.
   */
  sourceTokenDecimals?: number
  /** Receives non-fatal fee-mapping notices; see {@link ButterWarning}. */
  onWarning?: (warning: ButterWarning) => void
}

/** Effective WDK fee limits after constructor and per-call precedence. */
export interface ResolvedFeeLimits {
  maxNetworkFeeBps?: bigint
  maxProtocolFeeBps?: bigint
}

interface Ratio {
  numerator: bigint
  denominator: bigint
}

/** Resolves and validates constructor and per-call WDK fee limits. */
export function resolveFeeLimits (
  defaults: SwidgeProtocolConfig,
  overrides: SwidgeProtocolConfig
): ResolvedFeeLimits {
  const network = overrides.maxNetworkFeeBps ?? defaults.maxNetworkFeeBps
  const protocol = overrides.maxProtocolFeeBps ?? defaults.maxProtocolFeeBps
  const result: ResolvedFeeLimits = {}
  if (network != null) result.maxNetworkFeeBps = parseBps(network, 'maxNetworkFeeBps')
  if (protocol != null) result.maxProtocolFeeBps = parseBps(protocol, 'maxProtocolFeeBps')
  return result
}

/** Validates configured fee limits eagerly, rejecting malformed bps values. */
export function validateFeeLimits (config: SwidgeProtocolConfig): void {
  resolveFeeLimits(config, {})
}

/**
 * Rounding for **reported** fee amounts.
 *
 * These are display/estimate values, not enforced ones, so a Butter response with
 * more decimals than the token carries (a USDT fee quoted to 7 places) must not
 * reject the whole quote — under-reporting a displayed fee by one base unit cannot
 * harm the caller. Cap-enforcement parses elsewhere in this file deliberately keep
 * `'reject'`, or `'ceil'` where the value is a quoted upper bound.
 */
const DISPLAY_ROUNDING = { rounding: 'floor' } as const

/**
 * Maps Butter fee metadata into WDK fee entries using denomination-specific decimals.
 *
 * NOTE (upstream WDK contract): the base SwidgeProtocol's legacy `swap()` and
 * `bridge()` sum `fees[].amount` across entries regardless of denomination.
 * Butter fees can be denominated in different tokens (native, input token,
 * bridge token), so the legacy aggregated `fee` / `bridgeFee` have no coherent
 * unit when denominations differ. Consumers needing correct per-currency costs
 * must read the itemised `fees[]` on the SwidgeQuote/SwidgeResult, not the
 * legacy scalars. This cannot be fixed here without overriding legacy methods
 * (which providers must not do); it needs a WDK PR #39 mapping-contract change.
 */
export function mapRouteFees (route: ButterRoute, context: FeeContext): SwidgeFee[] {
  const fees: SwidgeFee[] = []
  const sourceToken = route.srcChain?.tokenIn
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)

  for (const component of bridgeFeeComponents(route)) {
    fees.push({
      // The affiliate share keeps WDK's own fee type; only the protocol *cap*
      // aggregates it (see protocolFeeRatios).
      type: component.role === 'affiliate' ? 'affiliate' : 'protocol',
      amount: parseTokenAmount(component.amount, componentDecimals(component, context), DISPLAY_ROUNDING),
      token: component.token,
      chain: route.bridgeFee?.chainId,
      included: true,
      description: component.description
    })
  }
  if (bridgeFeeComponentsMissing(route)) {
    // A non-zero summary with an affiliate share but no in/out cannot be split:
    // reporting the summary as a protocol fee would count the affiliate portion
    // twice, and reporting it as affiliate would overstate that. Say so instead.
    context.onWarning?.({
      code: 'bridge-fee-components-missing',
      message: 'Butter reported a bridge fee summary with no in/out/affiliate breakdown; the fee is omitted from fees[] because the summary is a single figure with a single token and is not attributable',
      details: { amount: route.bridgeFee?.amount }
    })
  }
  if (isNonZero(route.gasFee?.amount)) {
    fees.push({
      type: 'network',
      amount: parseTokenAmount(route.gasFee?.amount, nativeDecimals, DISPLAY_ROUNDING),
      token: requiredTokenId(route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context), 'network fee'),
      chain: route.gasFee?.chainId ?? context.sourceChainId,
      included: false,
      description: 'Estimated source chain gas fee'
    })
  }
  if (isNonZero(route.swapFee?.nativeFee)) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.swapFee?.nativeFee, nativeDecimals, DISPLAY_ROUNDING),
      token: requiredTokenId(
        route.swapFee?.nativeSymbol ?? route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context),
        'native protocol fee'
      ),
      chain: context.sourceChainId,
      included: false,
      description: 'Butter native swap fee'
    })
  }
  if (isNonZero(route.swapFee?.tokenFee)) {
    fees.push({
      type: 'protocol',
      // Trusted decimals, not the route's: a quote is where an understated scale does
      // its damage silently, since no cap has to be configured for a caller to read
      // the number and act on it.
      amount: parseTokenAmount(route.swapFee?.tokenFee, trustedSourceDecimals(context, sourceToken?.decimals, 'token protocol fee'), DISPLAY_ROUNDING),
      token: requiredTokenId(sourceToken?.address ?? context.sourceToken ?? route.swapFee?.tokenSymbol, 'token protocol fee'),
      chain: context.sourceChainId,
      included: true,
      description: 'Butter token swap fee'
    })
  }
  return reportFeeCaveats(fees, context)
}

/**
 * Emits the caveats a caller reading only WDK's surface could not otherwise see,
 * and guarantees a populated array.
 *
 * The WDK integration guide requires fees to always be a populated array, and an
 * empty one also reads as "free" rather than "Butter told us nothing". The
 * placeholder is zero-amount and only added when there is nothing else, so it can
 * never mask a real fee.
 */
function reportFeeCaveats (fees: SwidgeFee[], context: FeeContext): SwidgeFee[] {
  if (fees.length === 0) {
    context.onWarning?.({
      code: 'no-fees-reported',
      message: 'Butter reported no fees for this route; fees[] carries a zero-amount placeholder'
    })
    return [{
      type: 'network',
      amount: 0n,
      // A `network` fee is gas, which is always paid in the chain's native token —
      // never in the input token. `nativeTokenId` only answers when the source token
      // IS native, so fall back to the generic 'native' identifier (recognized in
      // NATIVE_TOKEN_ADDRESSES) rather than mislabelling gas as e.g. USDC.
      token: nativeTokenId(context) ?? 'native',
      chain: context.sourceChainId,
      included: false,
      description: 'Butter reported no fees for this route'
    }]
  }
  const protocolTokens = new Set(fees.filter(({ type }) => type === 'protocol').map(({ token }) => token))
  if (protocolTokens.size > 1) {
    context.onWarning?.({
      code: 'mixed-currency-protocol-fees',
      message: 'Butter protocol fees span multiple tokens; the WDK legacy bridgeFee scalar sums across denominations and is not meaningful — read fees[]',
      details: { tokens: [...protocolTokens] }
    })
  }
  return fees
}

/**
 * Returns the route's additional native protocol fee in source-chain base units.
 *
 * Rounds up: this value is the quoted side of an upper bound on `tx.value`
 * (`swap-data.ts`), so rounding down would turn a sub-wei formatting artifact in
 * Butter's decimal string into a rejected transaction. Rounding up can only widen
 * the bound by one wei, and the absolute `maxNativeFee` cap is unaffected.
 */
export function routeNativeFee (route: ButterRoute, context: FeeContext): bigint {
  return parseTokenAmount(
    route.swapFee?.nativeFee ?? '0',
    nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals),
    { rounding: 'ceil' }
  )
}

/** Enforces WDK network and protocol fee caps before transaction construction. */
export function enforceFeeLimits (
  route: ButterRoute,
  context: FeeContext,
  limits: ResolvedFeeLimits
): void {
  if (limits.maxNetworkFeeBps != null) {
    enforceLimit('network', networkFeeRatios(route, context), limits.maxNetworkFeeBps)
  }
  if (limits.maxProtocolFeeBps != null) {
    enforceLimit('protocol', protocolFeeRatios(route, context), limits.maxProtocolFeeBps)
  }
}

function networkFeeRatios (route: ButterRoute, context: FeeContext): Ratio[] {
  // Absent is NOT zero. An unreported gas fee cannot be valued, so a configured cap
  // must fail closed rather than score it as free — otherwise omitting the metadata
  // is enough to pass any limit. An explicit zero is a real answer and passes.
  // Only reached when a cap is configured (see enforceFeeLimits).
  if (route.gasFee?.amount == null) {
    throw new ButterFeeValuationError('Cannot enforce the Butter network fee cap: the route reports no gas fee amount')
  }
  if (!isNonZero(route.gasFee.amount)) return []
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)
  const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals)
  if (isNativeSource(context.sourceToken)) {
    // Source is native here, so native decimals are the source token's decimals.
    return [{ numerator: gasAmount, denominator: sourceDenominator(context, route, nativeDecimals) }]
  }
  return [usdRatio(route.gasFee?.inUSD, route.totalAmountInUSD, 'network fee')]
}

function protocolFeeRatios (route: ButterRoute, context: FeeContext): Ratio[] {
  const ratios: Ratio[] = []
  const sourceToken = route.srcChain?.tokenIn
  // Trusted, not route-reported: this number scales a numerator whose denominator
  // is the caller's real base units.
  const sourceDecimals = trustedSourceDecimals(context, sourceToken?.decimals, 'source token fee')
  const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals)
  // A cross-chain route always carries a bridge fee (route.ts rejects a cross-chain
  // response without dstChain, so its presence is the reliable cross-chain signal).
  // Absent is not zero: scoring an unreported fee as free would let omitted metadata
  // pass any cap, while an explicit component `"0"` is a real answer and passes.
  // Only a real component counts as "reported" — the top-level summary does not,
  // whatever its value. It is not priced because it is untrusted, so it cannot serve
  // as evidence either; accepting `{ amount: "0" }` as proof of a zero bridge fee let
  // a cross-chain route pass `maxProtocolFeeBps: 0` while reporting nothing valuable.
  // An affiliate-only bridge fee is legitimate and does count.
  if (route.dstChain != null && !hasBridgeFeeComponents(route.bridgeFee)) {
    throw new ButterFeeValuationError('Cannot enforce the Butter protocol fee cap: the cross-chain route reports no in/out/affiliate bridge fee amount', {
      summary: route.bridgeFee?.amount
    })
  }

  // swapFee is Butter's authoritative fee result and already includes the charge
  // described by feeConfig. feeConfig remains calldata-validation metadata only;
  // reading it here would either double count the referrer fee or make the cap use
  // a configuration value instead of the fee Butter actually quoted.
  if (route.swapFee?.nativeFee == null || route.swapFee.tokenFee == null) {
    throw new ButterFeeValuationError('Cannot enforce the Butter protocol fee cap: the route reports incomplete swap fee amounts', {
      swapFee: route.swapFee
    })
  }
  if (isNonZero(route.swapFee.tokenFee)) {
    ratios.push({
      numerator: parseTokenAmount(route.swapFee.tokenFee, sourceDecimals),
      denominator: sourceDenominator(context, route, sourceDecimals)
    })
  }

  if (isNonZero(route.swapFee.nativeFee)) {
    const nativeFee = parseTokenAmount(route.swapFee.nativeFee, nativeDecimals)
    if (isNativeSource(context.sourceToken)) {
      ratios.push({ numerator: nativeFee, denominator: sourceDenominator(context, route, nativeDecimals) })
    } else {
      const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals)
      const gasUsd = parseUsd(route.gasFee?.inUSD, 'native protocol fee')
      const inputUsd = parseUsd(route.totalAmountInUSD, 'native protocol fee')
      if (gasAmount === 0n) throw new ButterFeeValuationError('Cannot value Butter native protocol fee without a nonzero gas fee')
      ratios.push({ numerator: nativeFee * gasUsd, denominator: gasAmount * inputUsd })
    }
  }
  // A summary with no components is not valuable: it is one figure in one token for
  // a fee that can span three, and an untrusted response could omit the components
  // and offer a small, conveniently-denominated summary that satisfies any cap. Only
  // a non-zero one is refused — a zero summary charges nothing, so there is nothing
  // to bound, though it still warns as unattributable during mapping.
  if (unattributableBridgeFeeCharges(route)) {
    throw new ButterFeeValuationError('Cannot enforce the Butter protocol fee cap: the route reports a bridge fee summary with no in/out/affiliate breakdown to value', {
      amount: route.bridgeFee?.amount
    })
  }
  // The affiliate share is aggregated here even though `fees[]` types it as
  // `affiliate`: WDK has no affiliate cap, and leaving it out means the share is
  // unbounded — which bites hardest when `config.affiliate` is unset, because Butter
  // then substitutes its OWN wallet and the user pays a fee the integrator never
  // chose. `maxProtocolFeeBps` is the only knob available to bound it.
  for (const component of bridgeFeeComponents(route)) {
    ratios.push(bridgeFeeComponentRatio(component, route, context))
  }
  return ratios
}

/**
 * Which leg of the bridge a fee component is charged on. Drives both the WDK fee
 * type and, crucially, which route amount is a valid denominator for it — `in` and
 * `out` are frequently the same token, so without the role both would match the
 * same leg and an outbound fee would be measured against the inbound amount.
 */
type BridgeFeeRole = 'inbound' | 'outbound' | 'affiliate' | 'total'

/**
 * Decimals to price a bridge fee component with.
 *
 * A component denominated in the SOURCE token uses the resolved decimals, in both
 * quoting and cap enforcement: its amount is read against the caller's own input, so
 * an understated scale misstates it by a power of ten whether or not a cap happens
 * to be configured. A cross-denominated component keeps its declared decimals —
 * there the amount is only ever compared with a route-reported amount in the same
 * token, so any scaling error cancels and no trusted value exists anyway.
 */
function componentDecimals (component: BridgeFeeComponent, context: FeeContext): number {
  if (!isSourceTokenComponent(component.routeToken, context.sourceToken)) return component.decimals
  return trustedSourceDecimals(context, component.decimals, component.description)
}

/** One priced component of Butter's `bridgeFee`, carrying its OWN token. */
interface BridgeFeeComponent {
  role: BridgeFeeRole
  amount: string
  token: string
  decimals: number
  /** The route token this component is denominated in, for denominator matching. */
  routeToken: ButterRouteToken | undefined
  description: string
}

/**
 * Resolves `bridgeFee` into its priced components.
 *
 * Butter reports a bridge fee as a top-level `{ amount, address, symbol }` summary
 * plus `in`, `out` and `affiliate` parts that each carry their own amount and token.
 *
 * **Only the parts are ever used.** The summary is not priced, not reconstructed
 * from, not summed against, and not accepted as evidence that a fee was reported —
 * see `bridgeFeeComponentsMissing` and `hasBridgeFeeComponents`. It is a single
 * figure with a single token describing a fee that can span three tokens, which
 * makes it both unattributable and, for a partially trusted API, forgeable.
 *
 * Successive revisions of this function each tried to salvage some use for it —
 * pricing it, reconstructing `amount - affiliate`, checking the components' sum
 * against it, treating a zero as proof of no fee — and each was a way of trusting a
 * value the module had already decided not to trust. There is no safe use.
 *
 * Each component keeps its own token rather than sharing one guessed for the whole
 * fee: the parts can sit on different chains in different tokens, and folding them
 * into a single entry forced a guess about which one to report.
 */
function bridgeFeeComponents (route: ButterRoute): BridgeFeeComponent[] {
  const fee = route.bridgeFee
  const parts: Array<{ part: ButterFeePart | undefined, role: BridgeFeeRole }> = [
    { part: fee?.in, role: 'inbound' },
    { part: fee?.out, role: 'outbound' },
    { part: fee?.affiliate, role: 'affiliate' }
  ]
  const components: BridgeFeeComponent[] = []
  for (const { part, role } of parts) {
    if (!isNonZero(part?.amount)) continue
    components.push({
      role,
      amount: part?.amount as string,
      token: requiredTokenId(part?.token?.address ?? part?.token?.symbol, `${role} bridge fee`),
      decimals: requiredDecimals(part?.token, `${role} bridge fee`),
      routeToken: part?.token,
      description: role === 'affiliate' ? 'Butter affiliate fee' : `Butter ${role} bridge fee`
    })
  }
  return components
}

/**
 * True when a bridge fee summary describes a charge that no component accounts for.
 *
 * The summary is deliberately never priced. `amount` is a single figure with a
 * single token, while the real fee is up to three amounts in up to three tokens, so
 * for a partially trusted API it is both unattributable and forgeable: omit the
 * components, report a small summary that happens to match a route token, and any
 * bps cap is satisfied by a number the response invented. Reconstructing a
 * component from `amount - affiliate` — which a previous revision did — is the same
 * trust mistake wearing arithmetic.
 *
 * So it is only ever used as a *detector*: when the components do not add up to the
 * summary, quoting warns and omits, and a configured cap refuses.
 */
function bridgeFeeComponentsMissing (route: ButterRoute): boolean {
  // No arithmetic against the summary — not even a consistency check. The three
  // components can be in three different tokens, so comparing their "sum" to the
  // summary would mean adding unlike currencies, which is how an inconsistent
  // response comes to look consistent. Presence is the whole test.
  return route.bridgeFee?.amount != null && !hasBridgeFeeComponents(route.bridgeFee)
}

/**
 * True when an unattributable summary describes a fee that actually costs something.
 *
 * Reporting and refusing are separate questions. Any summary without components is
 * unattributable and says so through `bridge-fee-components-missing` — that is the
 * documented contract, and it holds for a `"0"` summary too. But a zero summary
 * describes no charge, so there is nothing for a cap to refuse; a same-chain route
 * legitimately sending `{ amount: '0' }` must not be blocked over it. Cross-chain is
 * covered regardless by the separate `hasBridgeFeeComponents` requirement.
 */
function unattributableBridgeFeeCharges (route: ButterRoute): boolean {
  return isNonZero(route.bridgeFee?.amount) && !hasBridgeFeeComponents(route.bridgeFee)
}

/**
 * True when at least one real bridge fee component reported an amount.
 *
 * An explicit `"0"` counts: a component saying "this leg charges nothing" is a real
 * answer. The top-level summary deliberately does NOT count, even when non-zero and
 * even when zero. It is untrusted enough that this package refuses to price it, and
 * a figure too untrusted to price is equally too untrusted to attest that a fee is
 * zero — otherwise `bridgeFee: { amount: "0" }` with no components satisfies any
 * cap, which is a cheaper forgery than inventing a small summary.
 */
function hasBridgeFeeComponents (fee: ButterBridgeFee | undefined): boolean {
  return fee?.in?.amount != null || fee?.out?.amount != null || fee?.affiliate?.amount != null
}

/**
 * Values one bridge fee component against a denominator in its OWN token.
 *
 * When the component is charged in the SOURCE token the caller's own input is
 * available and MUST be used: falling through to a route-reported amount reopens
 * precisely the bypass `sourceDenominator` exists to close — inflate
 * `srcChain.totalAmountIn` and any ratio can be pushed under a bps cap. A component
 * in some other token has no caller-supplied amount to divide by, which is the
 * documented trust concession; but it is matched strictly by token and **never**
 * falls back to an amount denominated in a different currency, since dividing by
 * the wrong currency produces a meaningless ratio.
 *
 * That match requires an **address** on both sides. A symbol is not a stable
 * identifier — two tokens on two chains routinely share one — so picking a
 * denominator by symbol means picking an amount that may not be in the fee's
 * currency at all. The source-token test above is deliberately the opposite: there,
 * matching loosely only ever routes a fee to a denominator the caller supplied.
 *
 * Candidates are ordered by the component's own leg. `in` and `out` are usually the
 * same token, so a single shared order made both match the inbound amount first —
 * and where `totalAmountIn > totalAmountOut`, that understates the outbound fee.
 */
function bridgeFeeComponentRatio (component: BridgeFeeComponent, route: ButterRoute, context: FeeContext): Ratio {
  const decimals = componentDecimals(component, context)
  if (isSourceTokenComponent(component.routeToken, context.sourceToken)) {
    return {
      numerator: parseTokenAmount(component.amount, decimals),
      denominator: sourceDenominator(context, route, decimals)
    }
  }
  if (!component.routeToken?.address?.trim()) {
    throw new ButterFeeValuationError('Cannot value a Butter bridge fee component that names no token address and is not the source token', {
      token: component.token,
      description: component.description
    })
  }
  const numerator = parseTokenAmount(component.amount, decimals)
  const inboundFirst: Array<{ token: ButterRouteToken | undefined, amount: string | undefined }> = [
    { token: route.bridgeChain?.tokenIn, amount: route.bridgeChain?.totalAmountIn },
    { token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut },
    { token: route.srcChain?.tokenIn, amount: route.srcChain?.totalAmountIn }
  ]
  const outboundFirst: Array<{ token: ButterRouteToken | undefined, amount: string | undefined }> = [
    { token: route.bridgeChain?.tokenOut, amount: route.bridgeChain?.totalAmountOut },
    { token: route.dstChain?.tokenOut, amount: route.dstChain?.totalAmountOut },
    { token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut }
  ]
  // An affiliate cut and an unsplit total are both taken on the way out.
  const candidates = component.role === 'inbound' ? inboundFirst : outboundFirst
  const denominator = candidates.find((candidate) => sameTokenAddress(candidate.token, component.routeToken) && candidate.amount != null)
  if (!denominator?.amount) {
    throw new ButterFeeValuationError('Cannot value a Butter bridge fee component against a route amount in the same token', {
      token: component.token,
      description: component.description
    })
  }
  return { numerator, denominator: parseTokenAmount(denominator.amount, decimals) }
}

/**
 * Two route tokens are the same currency only when both name the same address.
 *
 * Symbols are not identifiers: the same ticker appears on many chains, so matching
 * on one would pick a denominator that may be in a different currency than the fee.
 */
function sameTokenAddress (left: ButterRouteToken | undefined, right: ButterRouteToken | undefined): boolean {
  return sameIdentifier(left?.address, right?.address)
}

/**
 * True when a fee component is denominated in the caller's source token.
 *
 * The rule in one line: **a symbol can only ever confirm a symbolic identifier.**
 *
 * A declared address is positive evidence of which token this is, and a symbol may
 * not override it — `{ address: '0x…ee', symbol: 'BTC' }` is not the caller's BTC
 * however its ticker reads. A component with no address falls back to its symbol
 * only when `sourceToken` is itself symbolic (`'btc'`, `'sol'`, …), which is the
 * genuine shape on a non-EVM source. When `sourceToken` is an address, no symbol can
 * establish a match: a response could simply put that address in its `symbol` field.
 * Such a component is unidentifiable and is refused downstream.
 *
 * Each clause closes a bypass found in turn, and they pull in different directions,
 * which is why the whole matrix is pinned by tests rather than the latest case:
 * requiring an address outright sent a symbol-only BTC component into the
 * route-controlled denominator; letting a symbol beat an address divided a foreign
 * token's fee by the caller's source amount; and an unconditional symbol fallback
 * let that amount be claimed by any component willing to name it. A trusted
 * denominator is not automatically a meaningful one.
 */
function isSourceTokenComponent (token: ButterRouteToken | undefined, sourceToken: string): boolean {
  const source = sourceToken.trim()
  if (!source) return false
  // Addresses compare format-aware: lowercasing a Base58 mint would merge it with a
  // different one. Symbols stay case-insensitive — a ticker is not an identifier.
  if (token?.address?.trim()) return sameIdentifier(token.address, source)
  if (!SYMBOLIC_NATIVE_TOKEN_IDS.has(source.toLowerCase())) return false
  return token?.symbol?.trim().toLowerCase() === source.toLowerCase()
}

function enforceLimit (type: 'network' | 'protocol', ratios: Ratio[], maximumBps: bigint): void {
  let total: Ratio = { numerator: 0n, denominator: 1n }
  for (const ratio of ratios) {
    if (ratio.denominator <= 0n) throw new ButterFeeValuationError(`Cannot value Butter ${type} fee against a zero amount`)
    // A negative fee would subtract from the total and let a genuine one through.
    if (ratio.numerator < 0n) throw new ButterFeeValuationError(`Butter ${type} fee is negative`, { numerator: ratio.numerator.toString() })
    total = {
      numerator: total.numerator * ratio.denominator + ratio.numerator * total.denominator,
      denominator: total.denominator * ratio.denominator
    }
  }
  if (total.numerator * BPS_DENOMINATOR > maximumBps * total.denominator) {
    const actualBps = (total.numerator * BPS_DENOMINATOR + total.denominator - 1n) / total.denominator
    throw new ButterFeeLimitExceededError(type, actualBps, maximumBps)
  }
}

function usdRatio (feeUsd: string | undefined, inputUsd: string | undefined, label: string): Ratio {
  return {
    numerator: parseUsd(feeUsd, label),
    denominator: parseUsd(inputUsd, label)
  }
}

function parseUsd (value: string | undefined, label: string): bigint {
  if (value == null) throw new ButterFeeValuationError(`Cannot value Butter ${label} without USD metadata`)
  return parseTokenAmount(value, USD_DECIMALS)
}

/**
 * Denominator for source-denominated fee caps: the caller's exact input, NOT the
 * route-reported `srcChain.totalAmountIn` (which is untrusted and, if inflated,
 * would understate the ratio and let an over-cap fee pass).
 *
 * Exact-out has no exact input to use, so the denominator is
 * `min(maxFromTokenAmount, route-reported input)`. The `min` is what keeps this
 * safe in both directions: the caller's cap bounds it from above, so inflating the
 * reported input cannot understate the ratio; and if Butter instead under-reports,
 * the smaller denominator overstates the ratio and trips the cap, which is the
 * fail-closed direction. The reported value is only ever allowed to make the check
 * stricter, never looser.
 */
/**
 * Decimals to parse a SOURCE-token fee with, when it will be divided by the
 * caller's real base units.
 *
 * Takes the value this package resolved for the `/route` request and rejects a
 * route that disagrees with it. The mismatch itself is the signal: `route.ts` only
 * verifies the source token's *address*, so a response is free to claim
 * `decimals: 0` and shrink a 10 USDC fee from `10000000n` to `10n` — a
 * thousand-basis-point charge measured as one hundredth of one.
 */
function trustedSourceDecimals (context: FeeContext, declared: string | number | undefined, label: string): number {
  const trusted = context.sourceTokenDecimals
  if (trusted == null) {
    throw new ButterFeeValuationError(`Cannot value the Butter ${label} without trusted source token decimals`)
  }
  let parsedDeclared: number | undefined
  if (declared != null) {
    const normalized = typeof declared === 'string'
      ? (/^\d+$/.test(declared.trim()) ? Number(declared.trim()) : Number.NaN)
      : declared
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 255) {
      throw new ButterFeeValuationError(`Butter route reports invalid source token decimals; refusing to value the ${label}`, { declared })
    }
    parsedDeclared = normalized
  }
  if (parsedDeclared != null && parsedDeclared !== trusted) {
    throw new ButterFeeValuationError(`Butter route reports source token decimals that disagree with the resolved value; refusing to value the ${label}`, {
      declared: parsedDeclared,
      trusted
    })
  }
  return trusted
}

function sourceDenominator (context: FeeContext, route: ButterRoute, sourceDecimals: number): bigint {
  if (context.requestedAmountIn != null) return context.requestedAmountIn
  if (context.maxAmountIn == null) {
    throw new ButterFeeValuationError('Cannot value a source-denominated Butter fee without the requested input amount')
  }
  const reported = parseTokenAmount(route.srcChain?.totalAmountIn, sourceDecimals, { rounding: 'floor' })
  return reported > 0n && reported < context.maxAmountIn ? reported : context.maxAmountIn
}

// `bridgeFeeToken` and `tokenMatchesFee` are gone with the summary pricing they
// served: resolving "which token is this fee in" by scanning route legs was always a
// guess, and every priced fee now carries its own token.

// `sameToken` is gone: its symbol fallback is what let a fee be valued against an
// amount in a different currency. Use `sameTokenAddress` for denominator matching,
// or `isSourceTokenComponent` when the question is "is this the caller's token".

function requiredDecimals (token: ButterRouteToken | undefined, label: string): number {
  const decimals = Number(token?.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Butter ${label} is missing valid token decimals`)
  }
  return decimals
}

function requiredTokenId (value: string | undefined, label: string): string {
  const token = value?.trim()
  if (!token) throw new ButterApiError(`Butter ${label} is missing a token identifier`)
  return token
}

function nativeTokenId (context: FeeContext): string | undefined {
  return isNativeSource(context.sourceToken) ? context.sourceToken : undefined
}

/** Resolves source-chain native token decimals with caller overrides. */
export function nativeDecimalsForChain (chainId: string, configured: Record<string, number> | undefined): number {
  const configuredValue = configured?.[chainId]
  if (configuredValue != null) return configuredValue
  if (chainId === TRON_CHAIN_ID) return 6
  if (chainId === BTC_CHAIN_ID) return 8
  if (chainId === SOLANA_CHAIN_ID) return 9
  return 18
}

function isNativeSource (token: string): boolean {
  return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase())
}

function isNonZero (value: string | number | bigint | undefined): boolean {
  if (value == null) return false
  const raw = String(value).trim()
  return !/^0+(?:\.0+)?$/.test(raw)
}

function parseBps (value: number | bigint, field: string): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  }
  const result = BigInt(value)
  if (result < 0n) throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  return result
}
