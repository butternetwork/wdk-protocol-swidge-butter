import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol from '../../src/index.ts'
import {
  makeFetch, quoteRoute, sameChainSwapDataFor, ERC20_TOKEN, NATIVE_TOKEN,
  DEST_TOKEN, VALID_SENDER, VALID_RECIPIENT, ROUTER, dummyHash
} from '../helpers/protocol-fixtures.ts'

const input = 1500000000000000000n
type Limits = { maxNetworkFeeBps?: bigint, maxProtocolFeeBps?: bigint }

function harness (gasUsd: string | undefined, limits: Limits = {}, overrides: Record<string, unknown> = {}, nativeSource = false) {
  const source = nativeSource ? NATIVE_TOKEN : ERC20_TOKEN
  const sends: unknown[] = []
  const route = quoteRoute({
    bridgeFee: undefined, dstChain: undefined,
    gasFee: { amount: '0.0001', inUSD: gasUsd },
    swapFee: { nativeFee: '1', tokenFee: '0' },
    totalAmountInUSD: '1',
    srcChain: {
      chainId: '56', tokenIn: { address: source, decimals: 18 },
      tokenOut: { address: DEST_TOKEN, decimals: 6 },
      totalAmountIn: '1.5', totalAmountOut: '9.5'
    },
    ...overrides
  })
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [route] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, chainId: '56',
      value: String((nativeSource ? input : 0n) + (route.swapFee?.nativeFee === '0' ? 0n : 1000000000000000000n)),
      data: sameChainSwapDataFor(source, input)
    }] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    getAllowance: async () => input,
    sendTransaction: async (tx) => { sends.push(tx); return dummyHash(1) }
  }, {
    sourceChainId: 56, entrance: 'wdk', fetch,
    tokenDecimals: { [ERC20_TOKEN]: 18 }, ...limits
  })
  const options = {
    fromToken: source, toToken: DEST_TOKEN, fromTokenAmount: input,
    recipient: VALID_RECIPIENT
  }
  return { protocol, options, fetch, sends }
}

for (const category of ['network', 'protocol', 'both'] as const) {
  for (const cap of [0n, 10000n]) {
    for (const gasUsd of ['0', '0.00', ' 0.00 ']) {
      it(`rejects zero USD ${JSON.stringify(gasUsd)} with ${category} cap ${cap} before swap construction`, async () => {
        const test = harness(gasUsd, {
          ...(category !== 'protocol' ? { maxNetworkFeeBps: cap } : {}),
          ...(category !== 'network' ? { maxProtocolFeeBps: cap } : {})
        })

        await assert.rejects(test.protocol.swidge(test.options), {
          name: 'ButterFeeValuationError',
          message: `Cannot value Butter ${category === 'protocol' ? 'native protocol fee' : 'network fee'} without positive USD metadata`,
          details: { label: category === 'protocol' ? 'native protocol fee' : 'network fee', value: gasUsd }
        })

        assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
        assert.deepEqual(test.sends, [])
      })
    }
  }
}

for (const category of ['network', 'protocol'] as const) {
  const limits = category === 'network' ? { maxNetworkFeeBps: 0n } : { maxProtocolFeeBps: 0n }
  const label = category === 'network' ? 'network fee' : 'native protocol fee'
  for (const [gasUsd, error, message] of [
    [undefined, 'ButterFeeValuationError', `Cannot value Butter ${label} without USD metadata`],
    ['-1', 'ButterApiError', 'Invalid token amount: -1'],
    ['invalid', 'ButterApiError', 'Invalid token amount: invalid'],
    ['0.0000000000000000001', 'ButterApiError', 'Token amount exceeds 18 decimal places: 0.0000000000000000001']
  ] as const) {
    it(`rejects ${category} valuation with invalid USD ${gasUsd}`, async () => {
      const test = harness(gasUsd, limits)
      await assert.rejects(test.protocol.swidge(test.options), { name: error, message })
      assert.deepEqual(test.sends, [])
      assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
    })
  }

  for (const totalAmountInUSD of ['0', undefined]) {
    it(`rejects ${category} valuation without positive input USD ${totalAmountInUSD}`, async () => {
      const test = harness('1', limits, { totalAmountInUSD })
      await assert.rejects(test.protocol.swidge(test.options), {
        name: 'ButterFeeValuationError',
        message: `Cannot value Butter ${label} without ${totalAmountInUSD == null ? '' : 'positive '}USD metadata`
      })
      assert.deepEqual(test.sends, [])
    })
  }
}

for (const [category, gasUsd, cap, allowed] of [
  ['network', '0.01', 100n, true],
  ['network', '0.01', 99n, false],
  ['protocol', '0.000001', 100n, true],
  ['protocol', '0.000001', 99n, false],
  ['network', '0.000000000000000001', 1n, true],
  ['protocol', '0.000000000000000001', 1n, true],
  ['network', '0.000000000000000001', 0n, false],
  ['protocol', '0.000000000000000001', 0n, false]
] as const) {
  it(`compares positive ${category} USD ${gasUsd} exactly against cap ${cap}`, async () => {
    const test = harness(gasUsd, category === 'network' ? { maxNetworkFeeBps: cap } : { maxProtocolFeeBps: cap })
    if (allowed) {
      const result = await test.protocol.swidge(test.options)
      assert.equal(result.id, dummyHash(1))
      assert.equal(test.sends.length, 1)
    } else {
      await assert.rejects(test.protocol.swidge(test.options), {
        name: 'ButterFeeLimitExceededError',
        message: `Butter ${category} fee exceeds the configured limit`,
        details: { feeType: category, actualBps: cap === 0n ? '1' : '100', maximumBps: String(cap) }
      })
      assert.deepEqual(test.sends, [])
    }
  })
}

it('quotes zero USD metadata even with both caps configured', async () => {
  const test = harness('0', { maxNetworkFeeBps: 0n, maxProtocolFeeBps: 0n })
  const quote = await test.protocol.quoteSwidge(test.options)
  assert.deepEqual(quote.fees.map(({ amount }) => amount), [100000000000000n, 1000000000000000000n])
  assert.deepEqual(test.sends, [])
})

it('executes without requiring USD when no caps are configured', async () => {
  const test = harness('0')
  const result = await test.protocol.swidge(test.options)
  assert.equal(result.id, dummyHash(1))
  assert.equal(test.sends.length, 1)
})

it('allows explicit zero fees without USD metadata under zero caps', async () => {
  const test = harness(undefined, { maxNetworkFeeBps: 0n, maxProtocolFeeBps: 0n }, {
    gasFee: { amount: '0' }, swapFee: { nativeFee: '0', tokenFee: '0' }, totalAmountInUSD: undefined
  })
  const result = await test.protocol.swidge(test.options)
  assert.equal(result.id, dummyHash(1))
  assert.equal(test.sends.length, 1)
})

it('values native-source fees directly without USD metadata', async () => {
  const test = harness('0', { maxNetworkFeeBps: 10000n, maxProtocolFeeBps: 10000n }, { totalAmountInUSD: undefined }, true)
  const result = await test.protocol.swidge(test.options)
  assert.equal(result.id, dummyHash(1))
  assert.equal(test.sends.length, 1)
})

it('still refuses native protocol valuation using a zero gas amount', async () => {
  const test = harness('1', { maxProtocolFeeBps: 10000n }, { gasFee: { amount: '0', inUSD: '1' } })
  await assert.rejects(test.protocol.swidge(test.options), {
    name: 'ButterFeeValuationError', message: 'Cannot value Butter native protocol fee without a nonzero gas fee'
  })
  assert.deepEqual(test.sends, [])
})
