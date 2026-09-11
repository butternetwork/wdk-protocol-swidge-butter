import assert from 'node:assert/strict'
import { it } from 'node:test'
import { encodeAbiParameters, encodeFunctionData, zeroHash } from 'viem'
import ButterSwidgeProtocol from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, DEST_TOKEN, VALID_SENDER, VALID_RECIPIENT,
  ROUTER, routerV3Abi, swapParamAbi, dummyHash
} from '../helpers/protocol-fixtures.ts'

const input = 1000000000000000000n
const options = {
  fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 56,
  recipient: VALID_RECIPIENT, fromTokenAmount: input, slippage: 0.01
}

function sameChainRoute (decimals: unknown = 6, overrides: Record<string, unknown> = {}) {
  return quoteRoute({
    hash: 'valid-route', timestamp: 1000, dstChain: undefined, bridgeFee: undefined,
    gasFee: undefined, swapFee: { nativeFee: '0', tokenFee: '0' },
    srcChain: {
      chainId: '56', tokenIn: { address: NATIVE_TOKEN, decimals: 18 },
      tokenOut: { address: DEST_TOKEN, decimals },
      totalAmountIn: '1', totalAmountOut: '100'
    },
    minAmountOut: { amount: '99' },
    ...overrides
  })
}

function harness (route: () => unknown | Promise<unknown>, minimum = 99000000n) {
  let sends = 0
  const fetch = makeFetch({
    '/route': async () => ({ errno: 0, data: [await route()] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: String(input), chainId: '56',
      data: encodeFunctionData({
        abi: routerV3Abi, functionName: 'swapAndCall',
        args: [zeroHash, VALID_SENDER, NATIVE_TOKEN, input,
          encodeAbiParameters(swapParamAbi, [{
            dstToken: DEST_TOKEN, receiver: VALID_RECIPIENT, leftReceiver: VALID_SENDER,
            minAmount: minimum, swaps: []
          }]), '0x', '0x', '0x']
      })
    }] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => VALID_SENDER,
    sendTransaction: async () => { sends++; return { hash: dummyHash(1), fee: 0n } }
  }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000 })
  return { protocol, fetch, sends: () => sends }
}

for (const decimals of [null, false, true, '', ' ', [], [6], {}, '1e2', '0x06', -1, 1.5, 256]) {
  it(`rejects invalid destination precision ${JSON.stringify(decimals)} before quoting or sending`, async () => {
    const test = harness(() => sameChainRoute(decimals), 99n)

    await assert.rejects(test.protocol.quoteSwidge(options), {
      name: 'ButterApiError', message: 'Butter route is missing valid destination token decimals'
    })
    await assert.rejects(test.protocol.swidge(options), {
      name: 'ButterApiError', message: 'Butter route is missing valid destination token decimals'
    })

    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
  })

  it(`rejects invalid cross-denominated bridge precision ${JSON.stringify(decimals)}`, async () => {
    const test = harness(() => sameChainRoute(6, {
      dstChain: {
        chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '100'
      },
      bridgeFee: {
        chainId: '137', out: { amount: '1', token: { address: DEST_TOKEN, decimals } }
      }
    }))

    await assert.rejects(test.protocol.quoteSwidge({ ...options, toChain: 137, slippage: 0.02 }), {
      name: 'ButterApiError', message: 'Butter outbound bridge fee is missing valid token decimals'
    })

    assert.equal(test.sends(), 0)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
  })
}

for (const [decimals, minimum] of [[0, 99n], ['0', 99n], [6, 99000000n], [' 6 ', 99000000n]] as const) {
  it(`preserves valid destination precision ${JSON.stringify(decimals)} through pinned execution`, async () => {
    const test = harness(() => sameChainRoute(decimals), minimum)

    const quote = await test.protocol.quoteSwidge(options)
    const result = await test.protocol.swidge({ ...options, routeHash: quote.routeHash })

    assert.equal(quote.toTokenAmountMin, minimum)
    assert.equal(result.toTokenAmountMin, minimum)
    assert.equal(test.sends(), 1)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

it('retries a failed fee mapping against the service and pins the recovered quote', async () => {
  let routeCalls = 0
  const test = harness(() => {
    routeCalls++
    return routeCalls === 1
      ? sameChainRoute(6, { hash: 'invalid-route', swapFee: { nativeFee: '0', tokenFee: 'invalid' } })
      : sameChainRoute()
  })

  await assert.rejects(test.protocol.quoteSwidge(options), {
    name: 'ButterApiError', message: 'Invalid token amount: invalid'
  })
  const quote = await test.protocol.quoteSwidge(options)
  const result = await test.protocol.swidge({ ...options, routeHash: quote.routeHash })

  assert.equal(quote.routeHash, 'valid-route')
  assert.equal(result.toTokenAmountMin, 99000000n)
  assert.equal(routeCalls, 2)
  assert.equal(test.sends(), 1)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route', '/swap'])
})

it('keeps a successful quote executable when an older concurrent request fails mapping', { timeout: 5000 }, async () => {
  let routeCalls = 0
  let releaseFailure!: () => void
  let markStarted!: () => void
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve })
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const test = harness(async () => {
    routeCalls++
    if (routeCalls === 1) {
      markStarted()
      await failureGate
      return sameChainRoute(6, { hash: 'invalid-route', swapFee: { nativeFee: '0', tokenFee: 'invalid' } })
    }
    return sameChainRoute()
  })
  const failure = assert.rejects(test.protocol.quoteSwidge(options), {
    name: 'ButterApiError', message: 'Invalid token amount: invalid'
  })
  await firstStarted
  const quote = await test.protocol.quoteSwidge(options)

  releaseFailure()
  await failure
  const result = await test.protocol.swidge({ ...options, routeHash: quote.routeHash })

  assert.equal(quote.routeHash, 'valid-route')
  assert.equal(result.toTokenAmountMin, 99000000n)
  assert.equal(routeCalls, 2)
  assert.equal(test.sends(), 1)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route', '/swap'])
})

it('does not restore an executed pin when a concurrent quote uses the cached route', async () => {
  const test = harness(() => sameChainRoute())
  const quote = await test.protocol.quoteSwidge(options)

  const [execution, cachedQuote] = await Promise.all([
    test.protocol.swidge({ ...options, routeHash: quote.routeHash }),
    test.protocol.quoteSwidge(options)
  ])
  await assert.rejects(test.protocol.swidge({ ...options, routeHash: cachedQuote.routeHash }), {
    name: 'ButterActionRequiredError',
    message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
  })

  assert.equal(execution.toTokenAmountMin, 99000000n)
  assert.equal(cachedQuote.routeHash, quote.routeHash)
  assert.equal(test.sends(), 1)
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
})
