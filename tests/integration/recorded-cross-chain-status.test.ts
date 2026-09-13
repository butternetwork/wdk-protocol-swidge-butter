import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol, { ButterPartialExecutionError } from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, DEST_TOKEN, VALID_SENDER,
  VALID_RECIPIENT, ROUTER, crossChainSwapData, dummyHash, assertError
} from '../helpers/protocol-fixtures.ts'

const amount = 1500000000000000000n
const hash = dummyHash(10)
const destinationHash = dummyHash(11)
const options = {
  fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 137,
  recipient: VALID_RECIPIENT, fromTokenAmount: amount, slippage: 0.02
}
const correctResponse = {
  sourceHash: hash, toHash: destinationHash, fromChain: '56', toChain: '137', state: 1
}
const correctStatus = {
  status: 'completed',
  transactions: [
    { hash, chain: '56', type: 'source' },
    { hash: destinationHash, chain: '137', type: 'destination' }
  ]
}

function crossChainHarness (response: Record<string, unknown> = correctResponse, partial = false) {
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      srcChain: {
        chainId: '56', tokenIn: { address: NATIVE_TOKEN, decimals: 18 },
        totalAmountIn: '1.5', totalAmountOut: '1.5'
      },
      dstChain: {
        chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '10.25'
      },
      bridgeFee: undefined, swapFee: { nativeFee: '0', tokenFee: '0' }
    })] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: String(amount), chainId: '56', data: crossChainSwapData(NATIVE_TOKEN, amount)
    }] }),
    '/api/queryBridgeInfoBySourceHash': () => ({ code: 200, data: response }),
    '/api/queryCrossInfoByOrderId': () => ({ code: 200, data: response })
  })
  const sends: unknown[] = []
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    sendTransaction: async (transaction: unknown) => {
      sends.push(transaction)
      return { hash, fee: partial ? -1n : 0n }
    }
  }, { sourceChainId: 56, entrance: 'wdk', fetch, maxNativeFee: 0n, now: () => 1000 })
  return { protocol, fetch, sends }
}

for (const hints of [{}, { fromChain: 56 }, { toChain: '137' }, { fromChain: '56', toChain: 137 }]) {
  it(`accepts correct recorded cross-chain status with hints ${JSON.stringify(hints)}`, async () => {
    const test = crossChainHarness()
    await test.protocol.swidge(options)
    const originalHints = { ...hints }

    const result = await test.protocol.getSwidgeStatus(hash, hints)

    assert.deepEqual(result, correctStatus)
    assert.deepEqual(hints, originalHints)
    assert.equal(test.fetch.calls.at(-1)?.url.searchParams.get('hash'), hash)
    assert.equal(test.sends.length, 1)
  })
}

for (const [hints, side, chain] of [
  [{ fromChain: 1 }, 'source', '56'],
  [{ toChain: 10 }, 'destination', '137'],
  [{ fromChain: 1, toChain: 10 }, 'source', '56']
] as const) {
  it(`rejects conflicting recorded cross-chain hints ${JSON.stringify(hints)} before requesting status`, async () => {
    const test = crossChainHarness({ ...correctResponse, fromChain: '1', toChain: '10' })
    await test.protocol.swidge(options)

    await assert.rejects(test.protocol.getSwidgeStatus(hash, hints), {
      name: 'ButterApiError',
      message: `Butter status ${side} chain does not match request hints`,
      details: { id: hash, chain }
    })

    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

for (const [fields, side] of [
  [{ fromChain: '1', toChain: '137' }, 'source'],
  [{ fromChain: '56', toChain: '10' }, 'destination'],
  [{ fromChain: '1', toChain: '10' }, 'source'],
  [{ fromChain: { chainId: 1 }, toChain: { chainId: 137 } }, 'source'],
  [{ fromChainId: 56, toChainId: 10 }, 'destination']
] as const) {
  for (const hints of [{}, { fromChain: 56 }]) {
    it(`rejects conflicting recorded response ${JSON.stringify(fields)} with hints ${JSON.stringify(hints)}`, async () => {
      const response = { sourceHash: hash, toHash: destinationHash, state: 1, ...fields }
      const test = crossChainHarness(response)
      await test.protocol.swidge(options)

      await assert.rejects(test.protocol.getSwidgeStatus(hash, hints), {
        name: 'ButterApiError',
        message: `Butter status ${side} chain does not match request hints`,
        details: response
      })

      assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), [
        '/route', '/swap', '/api/queryBridgeInfoBySourceHash'
      ])
    })
  }
}

it('uses the recorded chains for a case-equivalent EVM source hash', async () => {
  const test = crossChainHarness({ ...correctResponse, toChain: '10' })
  await test.protocol.swidge(options)
  const uppercaseHash = `0x${'A'.repeat(64)}`

  await assert.rejects(test.protocol.getSwidgeStatus(uppercaseHash), {
    name: 'ButterApiError', message: 'Butter status destination chain does not match request hints'
  })

  assert.equal(test.fetch.calls.at(-1)?.url.searchParams.get('hash'), uppercaseHash)
})

it('validates recorded cross-chain status after a partial execution has broadcast the source', async () => {
  const test = crossChainHarness({ ...correctResponse, toChain: '10' }, true)
  await assert.rejects(test.protocol.swidge(options), (error: unknown) => {
    assertError(error, ButterPartialExecutionError,
      'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
    assert.deepEqual(error.transactions, [{ hash, chain: '56', type: 'source' }])
    return true
  })

  await assert.rejects(test.protocol.getSwidgeStatus(hash), {
    name: 'ButterApiError', message: 'Butter status destination chain does not match request hints'
  })

  assert.equal(test.sends.length, 1)
})

it('keeps order IDs separate even when the text equals a recorded source hash', async () => {
  const test = crossChainHarness({ ...correctResponse, fromChain: '1', toChain: '10' })
  await test.protocol.swidge(options)

  const result = await test.protocol.getSwidgeStatus(hash, { byOrderId: true, fromChain: 1, toChain: 10 })

  assert.deepEqual(result, {
    status: 'completed', transactions: [
      { hash, chain: '1', type: 'source' },
      { hash: destinationHash, chain: '10', type: 'destination' }
    ]
  })
  assert.equal(test.fetch.calls.at(-1)?.url.pathname, '/api/queryCrossInfoByOrderId')
  assert.equal(test.fetch.calls.at(-1)?.url.searchParams.get('orderId'), hash)
})

it('does not infer historical operation chains from a new instance source configuration', async () => {
  const test = crossChainHarness({ ...correctResponse, fromChain: '1', toChain: '10' })
  const fresh = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch: test.fetch })

  const result = await fresh.getSwidgeStatus(hash)

  assert.deepEqual(result, {
    status: 'completed', transactions: [
      { hash, chain: '1', type: 'source' },
      { hash: destinationHash, chain: '10', type: 'destination' }
    ]
  })
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/api/queryBridgeInfoBySourceHash'])
})

it('preserves optional response chain metadata for a recorded cross-chain operation', async () => {
  const test = crossChainHarness({ state: 1 })
  await test.protocol.swidge(options)

  const result = await test.protocol.getSwidgeStatus(hash)

  assert.deepEqual(result, { status: 'completed', transactions: [{ hash, type: 'source' }] })
})
