import assert from 'node:assert/strict'
import { it } from 'node:test'
import { encodeAbiParameters, encodeFunctionData, zeroHash } from 'viem'
import ButterSwidgeProtocol, { type ButterRoute } from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, ERC20_TOKEN, DEST_TOKEN, VALID_SENDER,
  VALID_RECIPIENT, ROUTER, routerV3Abi, swapParamAbi, dummyHash, crossChainSwapData
} from '../helpers/protocol-fixtures.ts'

const input = 1000000000000000000n
const options = {
  fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 56,
  recipient: VALID_RECIPIENT, fromTokenAmount: input, slippage: 0.01
}

function sameChainRoute (overrides: Record<string, unknown> = {}) {
  return quoteRoute({
    hash: 'approved-route', timestamp: 1000, bridgeFee: undefined, gasFee: undefined,
    dstChain: undefined, swapFee: { nativeFee: '0', tokenFee: '0' },
    srcChain: {
      chainId: '56', tokenIn: { address: NATIVE_TOKEN, decimals: 18 },
      tokenOut: { address: DEST_TOKEN, decimals: 6 },
      totalAmountIn: '1', totalAmountOut: '100'
    },
    minAmountOut: { amount: '99' },
    ...overrides
  })
}

function sameChainTransaction (minimum = 99000000n) {
  return {
    to: ROUTER, value: String(input), chainId: '56',
    data: encodeFunctionData({
      abi: routerV3Abi, functionName: 'swapAndCall',
      args: [zeroHash, VALID_SENDER, NATIVE_TOKEN, input,
        encodeAbiParameters(swapParamAbi, [{
          dstToken: DEST_TOKEN, receiver: VALID_RECIPIENT, leftReceiver: VALID_SENDER,
          minAmount: minimum, swaps: []
        }]), '0x', '0x', '0x']
    })
  }
}

function harness (route: () => unknown, minimum = 99000000n, now = () => 1000) {
  let sends = 0
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [route()] }),
    '/swap': () => ({ errno: 0, data: [sameChainTransaction(minimum)] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => VALID_SENDER,
    sendTransaction: async () => { sends++; return { hash: dummyHash(1), fee: 0n } }
  }, { sourceChainId: 56, entrance: 'wdk', fetch, now })
  return { protocol, fetch, sends: () => sends }
}

for (const extra of [
  { dstChain: { chainId: '56', tokenOut: { address: ERC20_TOKEN, decimals: 0 }, totalAmountOut: '1000000000' } },
  { bridgeChain: { chainId: '56' } }
]) {
  it(`rejects an unexpected same-chain segment ${Object.keys(extra)[0]} before sending`, async () => {
    const test = harness(() => sameChainRoute(extra), 99n)

    await assert.rejects(test.protocol.quoteSwidge(options), { name: 'ButterApiError', message: 'Butter same-chain route contains a destination or bridge segment' })
    await assert.rejects(test.protocol.swidge(options), { name: 'ButterApiError', message: 'Butter same-chain route contains a destination or bridge segment' })

    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
  })
}

for (const minAmountOut of [undefined, 0n, 99000000n]) {
  it(`rejects a 99 percent output reduction despite 1 percent slippage and floor ${minAmountOut}`, async () => {
    const test = harness(() => sameChainRoute({ minAmountOut: { amount: '1' } }), 1000000n)
    const request = { ...options, ...(minAmountOut != null ? { minAmountOut } : {}) }

    await assert.rejects(test.protocol.quoteSwidge(request), { name: 'ButterActionRequiredError', message: 'Butter route minimum output is below the requested minimum or slippage floor' })
    await assert.rejects(test.protocol.swidge(request), { name: 'ButterActionRequiredError', message: 'Butter route minimum output is below the requested minimum or slippage floor' })

    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
  })
}

for (const [output, minimum, slippage, expected] of [
  ['100', '99', 0.01, 99000000n],
  ['0.000101', '0.000100', 0.01, 100n],
  ['100', '100', 0, 100000000n]
] as const) {
  it(`executes output ${output} with minimum ${minimum} at slippage ${slippage}`, async () => {
    const route = sameChainRoute()
    const test = harness(() => ({
      ...route, srcChain: { ...(route.srcChain as object), totalAmountOut: output },
      minAmountOut: { amount: minimum }
    }), expected)
    const request = { ...options, slippage }

    const quote = await test.protocol.quoteSwidge(request)
    const result = await test.protocol.swidge({ ...request, routeHash: quote.routeHash })

    assert.equal(quote.toTokenAmountMin, expected)
    assert.equal(result.toTokenAmountMin, expected)
    assert.equal(test.sends(), 1)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
    assert.equal(test.fetch.calls[0]?.url.searchParams.get('slippage'), String(slippage * 10000))
    assert.equal(test.fetch.calls[1]?.url.searchParams.get('slippage'), String(slippage * 10000))
  })
}

it('rejects a minimum one base unit below the rounded-up slippage floor', async () => {
  const route = sameChainRoute()
  const test = harness(() => ({
    ...route, srcChain: { ...(route.srcChain as object), totalAmountOut: '0.000101' },
    minAmountOut: { amount: '0.000099' }
  }), 99n)

  await assert.rejects(test.protocol.swidge(options), {
    name: 'ButterActionRequiredError',
    message: 'Butter route minimum output is below the requested minimum or slippage floor',
    details: { requestedMinAmountOut: '0', slippageMinimum: '100', routeMinimum: '99' }
  })

  assert.equal(test.sends(), 0)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

it('checks explicit floors on cached quotes and pins without discarding a usable pin', async () => {
  const test = harness(() => sameChainRoute())
  const quote = await test.protocol.quoteSwidge(options)

  await assert.rejects(test.protocol.quoteSwidge({ ...options, minAmountOut: 100000000n }), { name: 'ButterActionRequiredError', message: 'Butter route minimum output is below the requested minimum or slippage floor' })
  await assert.rejects(test.protocol.swidge({ ...options, routeHash: quote.routeHash, minAmountOut: 100000000n }), { name: 'ButterActionRequiredError', message: 'Butter route minimum output is below the requested minimum or slippage floor' })
  assert.equal(test.sends(), 0)
  const result = await test.protocol.swidge({ ...options, routeHash: quote.routeHash })

  assert.equal(result.toTokenAmountMin, 99000000n)
  assert.equal(test.sends(), 1)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
})

it('rejects calldata below the validated same-chain quote minimum', async () => {
  const test = harness(() => sameChainRoute(), 98000000n)
  await assert.rejects(test.protocol.swidge(options), { name: 'ButterTransactionValidationError', message: 'Butter Router minimum output is below quoted minimum' })
  assert.equal(test.sends(), 0)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
})

for (const hash of [123, {}, null, '', ' ', ' approved-route ']) {
  it(`rejects remote hash ${JSON.stringify(hash)} without caching it`, async () => {
    let current: unknown = hash
    const test = harness(() => sameChainRoute({ hash: current }))

    await assert.rejects(test.protocol.quoteSwidge(options), { name: 'ButterApiError', message: 'Butter route is missing a valid hash' })
    await assert.rejects(test.protocol.swidge(options), { name: 'ButterApiError', message: 'Butter route is missing a valid hash' })
    current = 'approved-route'
    const quote = await test.protocol.quoteSwidge(options)

    assert.equal(quote.routeHash, 'approved-route')
    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route', '/route'])
  })

  it(`rejects explicit pin ${JSON.stringify(hash)} without requesting a route`, async () => {
    const test = harness(() => sameChainRoute())

    await assert.rejects(test.protocol.swidge({ ...options, routeHash: hash as never }), { name: 'ButterUnsupportedError', message: 'routeHash must be a non-empty string without surrounding whitespace' })

    assert.equal(test.sends(), 0)
    assert.equal(test.fetch.calls.length, 0)
  })
}

it('rejects an expiring opaque string pin instead of executing a cheaper new quote', async () => {
  let now = 1000
  const test = harness(() => sameChainRoute({ hash: '123' }), 49500000n, () => now)
  const quote = await test.protocol.quoteSwidge(options)
  now = 1260

  await assert.rejects(test.protocol.swidge({ ...options, routeHash: quote.routeHash }), { name: 'ButterActionRequiredError', message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote' })

  assert.equal(quote.routeHash, '123')
  assert.equal(quote.toTokenAmountMin, 99000000n)
  assert.equal(test.sends(), 0)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

function crossRoute (source = NATIVE_TOKEN, decimals = 18, feeChain: unknown = '137'): ButterRoute {
  return {
    hash: 'cross-route', timestamp: 1000,
    srcChain: { chainId: '56', tokenIn: { address: source, decimals: 18 }, totalAmountIn: '1' },
    bridgeChain: { chainId: '137', tokenOut: { address: source, decimals }, totalAmountOut: '0.02' },
    dstChain: { chainId: '137', tokenOut: { address: source, decimals }, totalAmountOut: '0.02' },
    minAmountOut: { amount: '0.019' }, swapFee: { nativeFee: '0', tokenFee: '0' },
    bridgeFee: { chainId: feeChain as string, out: { amount: '0.01', token: { address: source, decimals } } }
  }
}

function crossHarness (route: ButterRoute, maximum: number | null = 200) {
  let sends = 0
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [route] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: String(input), chainId: '56', data: crossChainSwapData(NATIVE_TOKEN, input)
    }] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => VALID_SENDER,
    sendTransaction: async () => { sends++; return dummyHash(1) }
  }, {
    sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000,
    tokenDecimals: { [ERC20_TOKEN]: 18 }, maxNativeFee: 0n,
    ...(maximum != null ? { maxProtocolFeeBps: maximum } : {})
  })
  const token = route.srcChain?.tokenIn?.address as string
  const request = { ...options, fromToken: token, toToken: token, toChain: 137, slippage: 0.02 }
  return { protocol, fetch, request, sends: () => sends }
}

for (const [source, decimals, expectedFee] of [[NATIVE_TOKEN, 18, 10000000000000000n], [ERC20_TOKEN, 6, 10000n]] as const) {
  it(`values a remote fee independently of the identical source address ${source}`, async () => {
    const test = crossHarness(crossRoute(source, decimals))
    const quote = await test.protocol.quoteSwidge(test.request)

    await assert.rejects(test.protocol.swidge({ ...test.request, routeHash: quote.routeHash }), {
      name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit',
      details: { feeType: 'protocol', actualBps: '5000', maximumBps: '200' }
    })

    assert.deepEqual(quote.fees, [{ type: 'protocol', amount: expectedFee, token: source, chain: '137', included: true, description: 'Butter outbound bridge fee' }])
    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
  })
}

it('allows the cross-chain fee when its correctly denominated ratio equals the cap', async () => {
  const test = crossHarness(crossRoute(), 5000)
  const result = await test.protocol.swidge(test.request)
  assert.equal(result.id, dummyHash(1))
  assert.equal(test.sends(), 1)
})

it('uses the caller input for an actual source-chain fee even with a smaller remote amount', async () => {
  const route = crossRoute(NATIVE_TOKEN, 18, '56')
  route.srcChain!.totalAmountIn = '1000000'
  const test = crossHarness(route, 50)
  await assert.rejects(test.protocol.swidge(test.request), {
    name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit',
    details: { feeType: 'protocol', actualBps: '100', maximumBps: '50' }
  })
  assert.equal(test.sends(), 0)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

for (const role of ['in', 'out', 'affiliate'] as const) {
  it(`uses the intermediate payment chain and the ${role} fee's own leg`, async () => {
    const route = crossRoute(NATIVE_TOKEN, 18, '22776')
    route.bridgeChain = {
      chainId: '22776', tokenIn: { address: NATIVE_TOKEN, decimals: 18 },
      tokenOut: { address: NATIVE_TOKEN, decimals: 18 },
      totalAmountIn: '0.2', totalAmountOut: '0.02'
    }
    route.dstChain!.totalAmountOut = '100'
    route.bridgeFee = { chainId: '22776', [role]: { amount: '0.01', token: { address: NATIVE_TOKEN, decimals: 18 } } }
    const test = crossHarness(route, 1000)
    const quote = await test.protocol.quoteSwidge(test.request)

    if (role === 'in') {
      const result = await test.protocol.swidge({ ...test.request, routeHash: quote.routeHash })
      assert.equal(result.id, dummyHash(1))
      assert.equal(test.sends(), 1)
    } else {
      await assert.rejects(test.protocol.swidge({ ...test.request, routeHash: quote.routeHash }), {
        name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit',
        details: { feeType: 'protocol', actualBps: '5000', maximumBps: '1000' }
      })
      assert.equal(test.sends(), 0)
      assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
    }
    assert.deepEqual(quote.fees, [{
      type: role === 'affiliate' ? 'affiliate' : 'protocol', amount: 10000000000000000n,
      token: NATIVE_TOKEN, chain: '22776', included: true,
      description: role === 'affiliate' ? 'Butter affiliate fee' : role === 'in' ? 'Butter inbound bridge fee' : 'Butter outbound bridge fee'
    }])
  })
}

it('refuses to value a foreign fee using an identical address on a different route chain', async () => {
  const test = crossHarness(crossRoute(NATIVE_TOKEN, 18, '1'))
  await assert.rejects(test.protocol.swidge(test.request), {
    name: 'ButterFeeValuationError', message: 'Cannot value a Butter bridge fee component against a route amount in the same token'
  })
  assert.equal(test.sends(), 0)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

it('still values a symbol-only Bitcoin source fee using the caller input', async () => {
  const chainId = '1360095883558913'
  let sends = 0
  const fetch = makeFetch({ '/route': () => ({ errno: 0, data: [{
    hash: 'btc-route', timestamp: 1000,
    srcChain: { chainId, tokenIn: { address: 'btc', decimals: 8 }, totalAmountIn: '1000000' },
    dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '1' },
    minAmountOut: { amount: '0.97' }, swapFee: { nativeFee: '0', tokenFee: '0' },
    bridgeFee: { chainId, in: { amount: '0.01', token: { symbol: 'BTC', decimals: 8 } } }
  }] }) })
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => 'btc-sender',
    sendTransaction: async () => { sends++; return dummyHash(1) }
  }, { sourceChainId: chainId, entrance: 'wdk', fetch, now: () => 1000, transactionAdapters: { [chainId]: (tx) => tx }, maxProtocolFeeBps: 50 })
  const request = { ...options, fromToken: 'btc', toChain: 137, fromTokenAmount: 100000000n, slippage: 0.03 }

  const quote = await protocol.quoteSwidge(request)
  await assert.rejects(protocol.swidge({ ...request, routeHash: quote.routeHash }), {
    name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit',
    details: { feeType: 'protocol', actualBps: '100', maximumBps: '50' }
  })
  assert.deepEqual(quote.fees, [{ type: 'protocol', token: 'BTC', amount: 1000000n, chain: chainId, included: true, description: 'Butter inbound bridge fee' }])
  assert.equal(sends, 0)
  assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

it('checks the default same-chain slippage without subtracting an input-token fee again', async () => {
  const test = harness(() => sameChainRoute({ swapFee: { nativeFee: '0', tokenFee: '0.002014' } }))
  const { slippage, ...request } = options
  const quote = await test.protocol.quoteSwidge(request)
  assert.equal(quote.toTokenAmount, 100000000n)
  assert.equal(quote.toTokenAmountMin, 99000000n)
  assert.equal(test.fetch.calls[0]?.url.searchParams.get('slippage'), '100')
})

for (const chain of [undefined, null, '', ' ', {}, true, -1, 1.5]) {
  it(`rejects nonzero bridge fees with invalid payment chain ${JSON.stringify(chain)}`, async () => {
    const route = crossRoute()
    route.bridgeFee!.chainId = chain as never
    const test = crossHarness(route, null)
    await assert.rejects(test.protocol.quoteSwidge(test.request), { name: 'ButterFeeValuationError', message: 'Butter bridge fee component is missing a valid payment chain' })
    await assert.rejects(test.protocol.swidge(test.request), { name: 'ButterFeeValuationError', message: 'Butter bridge fee component is missing a valid payment chain' })
    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
  })
}

it('accepts explicitly zero bridge components without unused chain or token metadata', async () => {
  const route = crossRoute()
  route.bridgeFee = { out: { amount: '0' } }
  const test = crossHarness(route, 0)
  const quote = await test.protocol.quoteSwidge(test.request)
  const result = await test.protocol.swidge({ ...test.request, routeHash: quote.routeHash })
  const expected = [{ type: 'network', amount: 0n, chain: '56', token: NATIVE_TOKEN, included: false, description: 'Butter reported no fees for this route' }]
  assert.deepEqual(quote.fees, expected)
  assert.deepEqual(result.fees, expected)
  assert.equal(test.sends(), 1)
})

for (const malformed of [
  { address: 123 }, { address: {} }, { address: ' ' },
  { address: ERC20_TOKEN, symbol: {} }, { address: ERC20_TOKEN, name: [] },
  { address: ERC20_TOKEN, chainId: {} }
]) {
  it(`isolates malformed catalog metadata ${JSON.stringify(malformed)} without seeding its decimals`, async () => {
    const fetch = makeFetch({
      '/supportedTokenList': () => ({ errno: 0, data: [{ chainId: '56', tokens: [
        { address: DEST_TOKEN, decimals: 6, symbol: 'OUT' }, { decimals: 0, ...malformed }
      ] }] }),
      '/findToken': (url) => {
        assert.equal(url.searchParams.get('address'), ERC20_TOKEN)
        return { errno: 0, data: [{ chainId: '56', address: ERC20_TOKEN, decimals: 6 }] }
      },
      '/route': (url) => {
        assert.equal(url.searchParams.get('amount'), '100')
        return { errno: 0, data: [sameChainRoute({ srcChain: {
          chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 6 },
          tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountIn: '100', totalAmountOut: '100'
        } })] }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000 })

    const catalog = await protocol.getSupportedTokens()
    const quote = await protocol.quoteSwidge({ ...options, fromToken: ERC20_TOKEN, fromTokenAmount: 100000000n })

    assert.deepEqual(catalog, [{ token: DEST_TOKEN, address: DEST_TOKEN, chain: '56', symbol: 'OUT', decimals: 6 }])
    assert.equal(quote.fromTokenAmount, 100000000n)
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedTokenList', '/findToken', '/route'])
  })
}

it('uses a valid catalog token alias without leaking an invalid address or altering identifier case', async () => {
  const fetch = makeFetch({ '/supportedTokenList': () => ({ errno: 0, data: [{ chainId: '56', tokens: [
    { address: {}, token: ' AbCd ', decimals: 6 }, { token: 'abcd', decimals: 6 }
  ] }] }) })
  const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  assert.deepEqual(await protocol.getSupportedTokens(), [
    { token: 'AbCd', address: 'AbCd', chain: '56', symbol: '', decimals: 6 },
    { token: 'abcd', address: 'abcd', chain: '56', symbol: '', decimals: 6 }
  ])
})
