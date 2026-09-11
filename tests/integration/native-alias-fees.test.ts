import assert from 'node:assert/strict'
import { it } from 'node:test'

import ButterSwidgeProtocol, { type ButterRoute } from '../../src/index.ts'
import { DEST_TOKEN, NATIVE_TOKEN, VALID_RECIPIENT, dummyHash, makeFetch } from '../helpers/protocol-fixtures.ts'

const NATIVE_ASSETS = [
  { chainId: '1360095883558913', alias: 'btc', token: NATIVE_TOKEN, decimals: 8, input: 100000000n, fee: 1000000n },
  { chainId: '728126428', alias: 'trx', token: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', decimals: 6, input: 1000000n, fee: 10000n },
  { chainId: '1360108768460801', alias: 'sol', token: 'So11111111111111111111111111111111111111112', decimals: 9, input: 1000000000n, fee: 10000000n }
] as const

type NativeAsset = typeof NATIVE_ASSETS[number]

const SOURCE_ADDRESS = 'AbCdEfGhijkLMnoPqrstUvWxyz123456789ABc'

function nativeFeeHarness (
  asset: NativeAsset,
  fromToken: string,
  bridgeFee: NonNullable<ButterRoute['bridgeFee']>,
  maxProtocolFeeBps?: number,
  totalAmountIn = '1'
) {
  const route: ButterRoute = {
    hash: 'native-alias-route', timestamp: 1000,
    srcChain: { chainId: asset.chainId, tokenIn: { address: fromToken, decimals: asset.decimals }, totalAmountIn },
    dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '1' },
    minAmountOut: { amount: '0.97' },
    swapFee: { nativeFee: '0', tokenFee: '0' },
    bridgeFee
  }
  const transaction = {
    to: 'native-router', value: '0', chainId: asset.chainId,
    data: undefined, method: undefined, args: undefined, memo: undefined
  }
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [route] }),
    '/swap': () => ({ errno: 0, data: [transaction] })
  })
  const sent: unknown[] = []
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => 'native-sender',
    sendTransaction: async (tx) => { sent.push(tx); return dummyHash(1) }
  }, {
    sourceChainId: asset.chainId, entrance: 'wdk', fetch, now: () => 1000,
    tokenDecimals: { [fromToken]: asset.decimals },
    transactionAdapters: { [asset.chainId]: (tx) => tx },
    maxNativeFee: 0n,
    ...(maxProtocolFeeBps == null ? {} : { maxProtocolFeeBps })
  })
  const request = {
    fromToken, toToken: DEST_TOKEN, toChain: '137', recipient: VALID_RECIPIENT,
    fromTokenAmount: asset.input, slippage: 0.03
  }
  return { protocol, request, fetch, sent, transaction }
}

for (const asset of NATIVE_ASSETS) {
  for (const role of ['in', 'out', 'affiliate'] as const) {
    const description = role === 'affiliate' ? 'Butter affiliate fee' : `Butter ${role === 'in' ? 'inbound' : 'outbound'} bridge fee`
    for (const [fromToken, symbol] of [['native', asset.alias.toUpperCase()], [asset.alias, 'native']] as const) {
      const bridgeFee = { chainId: asset.chainId, [role]: { amount: '0.01', token: { symbol, decimals: asset.decimals } } }

      it(`quotes and executes ${asset.alias} ${role} fees with ${fromToken}/${symbol} aliases below the cap`, async () => {
        const test = nativeFeeHarness(asset, fromToken, bridgeFee, 200)

        const quote = await test.protocol.quoteSwidge(test.request)
        const result = await test.protocol.swidge({ ...test.request, routeHash: quote.routeHash })

        const expectedFees = [{
          type: role === 'affiliate' ? 'affiliate' : 'protocol', amount: asset.fee,
          token: symbol, chain: asset.chainId, included: true, description
        }]
        assert.deepEqual(quote.fees, expectedFees)
        assert.deepEqual(result.fees, expectedFees)
        assert.equal(result.id, dummyHash(1))
        assert.deepEqual(test.sent, [test.transaction])
        assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
        assert.equal(test.fetch.calls[0]?.url.searchParams.get('tokenInAddress'), asset.token)
        assert.equal(test.fetch.calls[0]?.url.searchParams.get('amount'), '1')
      })

      it(`caps ${asset.alias} ${role} fees for ${fromToken}/${symbol} using caller input despite an inflated route amount`, async () => {
        const test = nativeFeeHarness(asset, fromToken, bridgeFee, 50, '1000000')
        const quote = await test.protocol.quoteSwidge(test.request)

        await assert.rejects(test.protocol.swidge({ ...test.request, routeHash: quote.routeHash }), {
          name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit',
          details: { feeType: 'protocol', actualBps: '100', maximumBps: '50' }
        })
        assert.deepEqual(test.sent, [])
        assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
      })

      it(`rejects wrong ${asset.alias} ${role} precision for ${fromToken}/${symbol} even without a fee cap`, async () => {
        const test = nativeFeeHarness(asset, fromToken, {
          chainId: asset.chainId, [role]: { amount: '1', token: { symbol, decimals: 0 } }
        })
        for (const method of ['quoteSwidge', 'swidge'] as const) {
          await assert.rejects(test.protocol[method](test.request), {
            name: 'ButterFeeValuationError',
            message: `Butter route reports source token decimals that disagree with the resolved value; refusing to value the ${description}`,
            details: { declared: 0, trusted: asset.decimals }
          })
        }
        assert.deepEqual(test.sent, [])
        assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
      })
    }
  }

  it(`matches ${asset.alias} aliases with mixed case and surrounding whitespace`, async () => {
    const test = nativeFeeHarness(asset, ' NaTiVe ', {
      chainId: asset.chainId, in: { amount: '0.01', token: { symbol: ` ${asset.alias.toUpperCase()} `, decimals: asset.decimals } }
    }, 200)

    const result = await test.protocol.swidge(test.request)

    assert.equal(result.fees[0]?.amount, asset.fee)
    assert.equal(result.id, dummyHash(1))
    assert.deepEqual(test.sent, [test.transaction])
    assert.equal(test.fetch.calls[0]?.url.searchParams.get('tokenInAddress'), asset.token)
  })

  it(`preserves explicit zero ${asset.alias} fees without token metadata`, async () => {
    const test = nativeFeeHarness(asset, 'native', { in: { amount: '0' } }, 0)

    const result = await test.protocol.swidge(test.request)

    assert.deepEqual(result.fees, [{
      type: 'network', amount: 0n, chain: asset.chainId, token: 'native', included: false,
      description: 'Butter reported no fees for this route'
    }])
    assert.deepEqual(test.sent, [test.transaction])
  })

  for (const scenario of [
    { name: 'wrong payment chain', fromToken: 'native', chainId: '137', symbol: asset.alias },
    { name: 'another chain native symbol', fromToken: 'native', chainId: asset.chainId, symbol: asset.alias === 'btc' ? 'sol' : 'btc' },
    { name: 'unknown symbol', fromToken: 'native', chainId: asset.chainId, symbol: 'UNKNOWN' },
    { name: 'EVM native symbol', fromToken: 'native', chainId: asset.chainId, symbol: 'ETH' },
    { name: 'address in symbol', fromToken: 'native', chainId: asset.chainId, symbol: asset.token },
    { name: 'address-form native source', fromToken: asset.token, chainId: asset.chainId, symbol: asset.alias },
    { name: 'address-form token source', fromToken: SOURCE_ADDRESS, chainId: asset.chainId, symbol: asset.alias }
  ]) {
    it(`refuses a symbol-only ${asset.alias} component with ${scenario.name}`, async () => {
      const test = nativeFeeHarness(asset, scenario.fromToken, {
        chainId: scenario.chainId, in: { amount: '0.01', token: { symbol: scenario.symbol, decimals: asset.decimals } }
      }, 200)

      await assert.rejects(test.protocol.swidge(test.request), {
        name: 'ButterFeeValuationError',
        message: 'Cannot value a Butter bridge fee component that names no token address and is not the source token'
      })
      assert.deepEqual(test.sent, [])
      assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
    })
  }

  it(`does not let a ${asset.alias} symbol override a conflicting component address`, async () => {
    const test = nativeFeeHarness(asset, 'native', {
      chainId: asset.chainId, in: { amount: '0.01', token: { address: SOURCE_ADDRESS, symbol: asset.alias, decimals: asset.decimals } }
    }, 200)

    await assert.rejects(test.protocol.swidge(test.request), {
      name: 'ButterFeeValuationError',
      message: 'Cannot value a Butter bridge fee component against a route amount in the same token'
    })
    assert.deepEqual(test.sent, [])
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
  })

  it(`refuses a nonzero ${asset.alias} component with no symbol or address`, async () => {
    const test = nativeFeeHarness(asset, 'native', {
      chainId: asset.chainId, in: { amount: '0.01', token: { decimals: asset.decimals } }
    }, 200)

    await assert.rejects(test.protocol.swidge(test.request), {
      name: 'ButterApiError', message: 'Butter inbound bridge fee is missing a token identifier'
    })
    assert.deepEqual(test.sent, [])
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
  })
}

it('does not merge differently cased Solana fee and source addresses even with a native symbol', async () => {
  const asset = NATIVE_ASSETS[2]
  const test = nativeFeeHarness(asset, SOURCE_ADDRESS, {
    chainId: asset.chainId,
    in: { amount: '0.01', token: { address: SOURCE_ADDRESS.toLowerCase(), symbol: 'native', decimals: asset.decimals } }
  }, 200)

  await assert.rejects(test.protocol.swidge(test.request), {
    name: 'ButterFeeValuationError',
    message: 'Cannot value a Butter bridge fee component against a route amount in the same token'
  })
  assert.deepEqual(test.sent, [])
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})
