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
  SOLANA_CHAIN_ID,
  BTC_CHAIN_ID,
  TRON_CHAIN_ID
} from './constants.js'
import { parseTokenAmount } from './amounts.js'
import {
  isNativeTokenIdentifier,
  isSymbolicNativeTokenIdentifier,
  sameTokenIdentifier
} from './identifiers.js'
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

/**
 * Resolves and validates constructor and per-call WDK fee limits.
 *
 * @param {SwidgeProtocolConfig} defaults - The constructor-level defaults used when no override is present.
 * @param {SwidgeProtocolConfig} overrides - The per-call or per-chain overrides to apply.
 * @returns {ResolvedFeeLimits} The validated limits after per-call values override constructor defaults.
 */
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

/**
 * Validates configured fee limits eagerly, rejecting malformed bps values.
 *
 * @param {SwidgeProtocolConfig} config - The configuration used by the operation.
 * @returns {void} Nothing; the function throws when validation fails.
 */
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {SwidgeFee[]} The mapped provider result.
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
      ...(route.bridgeFee?.chainId != null ? { chain: route.bridgeFee.chainId } : {}),
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
 *
 * @param {SwidgeFee[]} fees - The mapped WDK fees to inspect.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {SwidgeFee[]} The original fees after emitting any non-fatal caveat.
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
      // by every chain) rather than mislabelling gas as e.g. USDC.
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {bigint} The additional native protocol fee in source-chain base units.
 */
export function routeNativeFee (route: ButterRoute, context: FeeContext): bigint {
  return parseTokenAmount(
    route.swapFee?.nativeFee ?? '0',
    nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals),
    { rounding: 'ceil' }
  )
}

/**
 * Enforces WDK network and protocol fee caps before transaction construction.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @param {ResolvedFeeLimits} limits - The resolved fee limits to enforce.
 * @returns {void} Nothing; the function throws when validation fails.
 */
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

/**
 * Builds the source-denominated or USD-denominated ratios used for the network fee cap.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {Ratio[]} The ratios to enforce against the network fee cap.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 */
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
  if (isNativeSource(context.sourceChainId, context.sourceToken)) {
    // Source is native here, so native decimals are the source token's decimals.
    return [{ numerator: gasAmount, denominator: sourceDenominator(context) }]
  }
  return [usdRatio(route.gasFee?.inUSD, route.totalAmountInUSD, 'network fee')]
}

/**
 * Builds the per-component ratios used for the aggregate protocol fee cap.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {Ratio[]} The ratios to aggregate against the protocol fee cap.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 */
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
      denominator: sourceDenominator(context)
    })
  }

  if (isNonZero(route.swapFee.nativeFee)) {
    const nativeFee = parseTokenAmount(route.swapFee.nativeFee, nativeDecimals)
    if (isNativeSource(context.sourceChainId, context.sourceToken)) {
      ratios.push({ numerator: nativeFee, denominator: sourceDenominator(context) })
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
 *
 * @param {BridgeFeeComponent} component - The fee component to inspect or value.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {number} The trusted decimals used to parse the fee component.
 */
function componentDecimals (component: BridgeFeeComponent, context: FeeContext): number {
  if (!isSourceTokenComponent(component.routeToken, context.sourceChainId, context.sourceToken)) return component.decimals
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @returns {BridgeFeeComponent[]} The independently denominated bridge fee components.
 */
function bridgeFeeComponents (route: ButterRoute): BridgeFeeComponent[] {
  const fee = route.bridgeFee
  const parts: { part: ButterFeePart | undefined, role: BridgeFeeRole }[] = [
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @returns {boolean} Whether a bridge summary lacks attributable components.
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @returns {boolean} Whether the route reports an unpriceable non-zero bridge summary.
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
 *
 * @param {ButterBridgeFee | undefined} fee - The fee value or metadata to inspect.
 * @returns {boolean} Whether any inbound, outbound, or affiliate component declares an amount.
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
 *
 * @param {BridgeFeeComponent} component - The fee component to inspect or value.
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {Ratio} The fee component ratio and its same-token denominator.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 */
function bridgeFeeComponentRatio (component: BridgeFeeComponent, route: ButterRoute, context: FeeContext): Ratio {
  const decimals = componentDecimals(component, context)
  if (isSourceTokenComponent(component.routeToken, context.sourceChainId, context.sourceToken)) {
    return {
      numerator: parseTokenAmount(component.amount, decimals),
      denominator: sourceDenominator(context)
    }
  }
  if (!component.routeToken?.address?.trim()) {
    throw new ButterFeeValuationError('Cannot value a Butter bridge fee component that names no token address and is not the source token', {
      token: component.token,
      description: component.description
    })
  }
  const numerator = parseTokenAmount(component.amount, decimals)
  const inboundFirst: { chainId: string, token: ButterRouteToken | undefined, amount: string | undefined }[] = [
    { chainId: String(route.bridgeChain?.chainId ?? ''), token: route.bridgeChain?.tokenIn, amount: route.bridgeChain?.totalAmountIn },
    { chainId: String(route.srcChain?.chainId ?? context.sourceChainId), token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut },
    { chainId: String(route.srcChain?.chainId ?? context.sourceChainId), token: route.srcChain?.tokenIn, amount: route.srcChain?.totalAmountIn }
  ]
  const outboundFirst: { chainId: string, token: ButterRouteToken | undefined, amount: string | undefined }[] = [
    { chainId: String(route.bridgeChain?.chainId ?? ''), token: route.bridgeChain?.tokenOut, amount: route.bridgeChain?.totalAmountOut },
    { chainId: String(route.dstChain?.chainId ?? ''), token: route.dstChain?.tokenOut, amount: route.dstChain?.totalAmountOut },
    { chainId: String(route.srcChain?.chainId ?? context.sourceChainId), token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut }
  ]
  // An affiliate cut and an unsplit total are both taken on the way out.
  const candidates = component.role === 'inbound' ? inboundFirst : outboundFirst
  const denominator = candidates.find((candidate) => sameTokenAddress(candidate.chainId, candidate.token, component.routeToken) && candidate.amount != null)
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
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {ButterRouteToken | undefined} left - The first value to compare.
 * @param {ButterRouteToken | undefined} right - The second value to compare.
 * @returns {boolean} Whether both route tokens carry equivalent addresses for the specified chain.
 */
function sameTokenAddress (
  chainId: string,
  left: ButterRouteToken | undefined,
  right: ButterRouteToken | undefined
): boolean {
  return sameTokenIdentifier(chainId, left?.address, right?.address)
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
 *
 * @param {ButterRouteToken | undefined} token - The bridge component's declared token metadata.
 * @param {string} sourceChainId - The source-chain identifier.
 * @param {string} sourceToken - The source-token identifier.
 * @returns {boolean} Whether the component can be attributed to the caller's source token.
 */
function isSourceTokenComponent (
  token: ButterRouteToken | undefined,
  sourceChainId: string,
  sourceToken: string
): boolean {
  const source = sourceToken.trim()
  if (!source) return false
  // Addresses compare format-aware: lowercasing a Base58 mint would merge it with a
  // different one. Symbols stay case-insensitive — a ticker is not an identifier.
  if (token?.address?.trim()) return sameTokenIdentifier(sourceChainId, token.address, source)
  if (!isSymbolicNativeTokenIdentifier(sourceChainId, source)) return false
  return token?.symbol?.trim().toLowerCase() === source.toLowerCase()
}

/**
 * Enforces limit.
 *
 * @param {'network' | 'protocol'} type - The fee or transaction category being processed.
 * @param {Ratio[]} ratios - The fee ratios to aggregate before enforcing the cap.
 * @param {bigint} maximumBps - The maximum allowed fee ratio in basis points.
 * @returns {void} Nothing; the function throws when validation fails.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 * @throws {ButterFeeLimitExceededError} If a configured fee cap is exceeded.
 */
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

/**
 * Builds a fee-to-input ratio from Butter USD metadata.
 *
 * @param {string | undefined} feeUsd - The fee value expressed in Butter USD metadata.
 * @param {string | undefined} inputUsd - The input value expressed in Butter USD metadata.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {Ratio} The fee-to-input USD ratio.
 */
function usdRatio (feeUsd: string | undefined, inputUsd: string | undefined, label: string): Ratio {
  return {
    numerator: parseUsd(feeUsd, label),
    denominator: parseUsd(inputUsd, label)
  }
}

/**
 * Converts required Butter USD metadata to the package's fixed 18-decimal base units.
 *
 * @param {string | undefined} value - The Butter USD amount to convert.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {bigint} The USD amount expressed with 18 decimals.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 */
function parseUsd (value: string | undefined, label: string): bigint {
  if (value == null) throw new ButterFeeValuationError(`Cannot value Butter ${label} without USD metadata`)
  return parseTokenAmount(value, USD_DECIMALS)
}

/**
 * Decimals to parse a SOURCE-token fee with, when it will be divided by the
 * caller's real base units.
 *
 * Takes the value this package resolved for the `/route` request and rejects a
 * route that disagrees with it. The mismatch itself is the signal: `route.ts` only
 * verifies the source token's *address*, so a response is free to claim
 * `decimals: 0` and shrink a 10 USDC fee from `10000000n` to `10n` — a
 * thousand-basis-point charge measured as one hundredth of one.
 *
 * @param {FeeContext} context - The validated context required by the operation.
 * @param {string | number | undefined} declared - The source decimals declared by the Butter route.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {number} The locally resolved source decimals after route consistency checks.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
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

/**
 * Returns the trusted source-token amount used as a fee denominator.
 *
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {bigint} The trusted source-token denominator in base units.
 * @throws {ButterFeeValuationError} If a fee cannot be valued against a trustworthy denominator.
 */
function sourceDenominator (context: FeeContext): bigint {
  if (context.requestedAmountIn != null) return context.requestedAmountIn
  throw new ButterFeeValuationError('Cannot value a source-denominated Butter fee without the requested input amount')
}

// `bridgeFeeToken` and `tokenMatchesFee` are gone with the summary pricing they
// served: resolving "which token is this fee in" by scanning route legs was always a
// guess, and every priced fee now carries its own token.

// `sameToken` is gone: its symbol fallback is what let a fee be valued against an
// amount in a different currency. Use `sameTokenAddress` for denominator matching,
// or `isSourceTokenComponent` when the question is "is this the caller's token".

/**
 * Requires a valid decimal count on a route token.
 *
 * @param {ButterRouteToken | undefined} token - The route token whose decimals are required.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {number} The validated token decimal count.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
function requiredDecimals (token: ButterRouteToken | undefined, label: string): number {
  const decimals = Number(token?.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ButterApiError(`Butter ${label} is missing valid token decimals`)
  }
  return decimals
}

/**
 * Returns a non-empty fee token identifier.
 *
 * @param {string | undefined} value - The reported fee token identifier.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {string} The validated non-empty token identifier.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
function requiredTokenId (value: string | undefined, label: string): string {
  const token = value?.trim()
  if (!token) throw new ButterApiError(`Butter ${label} is missing a token identifier`)
  return token
}

/**
 * Returns the configured source-native token identifier used for fee reporting.
 *
 * @param {FeeContext} context - The validated context required by the operation.
 * @returns {string | undefined} The source-native token identifier, or undefined when unavailable.
 */
function nativeTokenId (context: FeeContext): string | undefined {
  return isNativeSource(context.sourceChainId, context.sourceToken) ? context.sourceToken : undefined
}

/**
 * Resolves source-chain native token decimals with caller overrides.
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {Record<string, number> | undefined} configured - The caller-supplied configuration values.
 * @returns {number} The configured or built-in native-token decimal count.
 */
export function nativeDecimalsForChain (chainId: string, configured: Record<string, number> | undefined): number {
  const configuredValue = configured?.[chainId]
  if (configuredValue != null) return configuredValue
  if (chainId === TRON_CHAIN_ID) return 6
  if (chainId === BTC_CHAIN_ID) return 8
  if (chainId === SOLANA_CHAIN_ID) return 9
  return 18
}

/**
 * Returns whether the requested source token is the chain native asset.
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {string} token - The requested source token identifier.
 * @returns {boolean} Whether the token denotes the source chain's native asset.
 */
function isNativeSource (chainId: string, token: string): boolean {
  return isNativeTokenIdentifier(chainId, token)
}

/**
 * Returns whether an optional integer-like value represents a non-zero amount.
 *
 * @param {string | number | bigint | undefined} value - The optional amount metadata to inspect.
 * @returns {boolean} Whether an amount is present and is not a decimal representation of zero.
 */
function isNonZero (value: string | number | bigint | undefined): boolean {
  if (value == null) return false
  const raw = String(value).trim()
  return !/^0+(?:\.0+)?$/.test(raw)
}

/**
 * Converts a non-negative integer fee cap to bigint basis points.
 *
 * @param {number | bigint} value - The caller-provided basis-point cap.
 * @param {string} field - The caller-facing field name used in validation errors.
 * @returns {bigint} The validated basis-point cap.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
function parseBps (value: number | bigint, field: string): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  }
  const result = BigInt(value)
  if (result < 0n) throw new ButterConfigurationError(`${field} must be a non-negative integer`)
  return result
}
