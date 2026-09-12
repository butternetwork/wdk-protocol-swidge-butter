import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setImmediate as flushAsyncWork } from 'node:timers/promises'
import { decodeFunctionData, erc20Abi } from 'viem'
import ButterSwidgeProtocol, {
  ButterActionRequiredError, ButterPartialExecutionError
} from '../../src/index.ts'
import {
  makeFetch, quoteRoute, sameChainErc20Options, sameChainSwapDataFor,
  ERC20_TOKEN, ERC20_TOKEN_DECIMALS, NATIVE_TOKEN, DEST_TOKEN, ROUTER,
  VALID_SENDER, dummyHash, assertError, threeTxAdapterFetch, threeTxAdapter
} from '../helpers/protocol-fixtures.ts'

const amount = sameChainErc20Options.fromTokenAmount
const hash = quoteRoute().hash
const message = 'Butter quote expires too soon; request a new quote'

function evmHarness (settings: {
  native?: boolean, initial?: bigint, margin?: number, timestamp?: boolean,
  at?: 'swap' | 'read' | 'reset' | 'amount' | 'sender' | 'delayed-allowance', time?: number
} = {}) {
  let now = 1000
  let allowance = settings.initial ?? amount
  let pending: bigint | undefined
  let postReads = 0
  const sent: string[] = []
  const sourceToken = settings.native ? NATIVE_TOKEN : ERC20_TOKEN
  const advance = () => { now = settings.time ?? 1255 }
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      ...(settings.timestamp === false ? {} : { timestamp: 1000 }),
      bridgeFee: undefined, gasFee: undefined, dstChain: undefined,
      swapFee: { nativeFee: '0', tokenFee: '0' },
      srcChain: {
        chainId: '56', tokenIn: { address: sourceToken, decimals: 18 },
        tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountIn: '1.5', totalAmountOut: '9.5'
      }
    })] }),
    '/swap': () => {
      if (settings.at === 'swap') advance()
      return { errno: 0, data: [{
        to: ROUTER, value: settings.native ? amount.toString() : '0', chainId: '56',
        data: sameChainSwapDataFor(sourceToken, amount)
      }] }
    }
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    getAllowance: async () => {
      if (settings.at === 'read') advance()
      if (settings.at === 'delayed-allowance' && sent.length > 0) {
        if (++postReads === 1) return 0n
        advance()
      }
      return allowance
    },
    getTransactionReceipt: async transactionHash => {
      allowance = pending!
      if (settings.at === (pending === 0n ? 'reset' : 'amount')) advance()
      return { status: 'success', transactionHash }
    },
    sendTransaction: async raw => {
      const tx = raw as { to: string, data: `0x${string}` }
      if (tx.to === ERC20_TOKEN) {
        pending = decodeFunctionData({ abi: erc20Abi, data: tx.data }).args![1] as bigint
        sent.push(`approve:${pending}`)
      } else sent.push('source')
      if (settings.at === 'sender') advance()
      return { hash: dummyHash(sent.length), fee: 10n }
    }
  }, {
    sourceChainId: 56, entrance: 'wdk', now: () => now, fetch,
    tokenDecimals: ERC20_TOKEN_DECIMALS,
    ...(settings.margin == null ? {} : { routeExecutionMarginSeconds: settings.margin })
  })
  return { protocol, sent, fetch, options: { ...sameChainErc20Options, fromToken: sourceToken } }
}

function assertFreshnessError (error: unknown, now: number, margin = 45) {
  assertError(error, ButterActionRequiredError, message)
  assert.deepEqual(error.details, { hash, expiresAt: 1300, now, margin })
}

for (const native of [false, true]) {
  for (const pinned of [false, true]) {
    for (const time of [1255, 1301]) {
      it(`stops after a delayed swap response at ${time}, native=${native}, pinned=${pinned}`, async () => {
        const h = evmHarness({ native, at: 'swap', time })
        const quote = pinned ? await h.protocol.quoteSwidge(h.options) : undefined

        await assert.rejects(h.protocol.swidge({
          ...h.options, ...(quote ? { routeHash: quote.routeHash } : {})
        }), error => { assertFreshnessError(error, time); return true })

        assert.deepEqual(h.sent, [])
        assert.deepEqual(h.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
      })
    }
  }
}

for (const margin of [0, 20, 45]) {
  for (const offset of [-1, 0, 1]) {
    it(`checks the send boundary with margin ${margin} and offset ${offset}`, async () => {
      const time = 1300 - margin + offset
      const h = evmHarness({ at: 'read', margin, time })

      if (offset < 0) {
        const result = await h.protocol.swidge(h.options)
        assert.equal(result.id, dummyHash(1))
        assert.deepEqual(h.sent, ['source'])
      } else {
        await assert.rejects(h.protocol.swidge(h.options), error => {
          assertFreshnessError(error, time, margin)
          return true
        })
        assert.deepEqual(h.sent, [])
      }
    })
  }
}

it('does not send an approval after the initial allowance read consumes the margin', async () => {
  const h = evmHarness({ initial: 0n, at: 'read' })
  await assert.rejects(h.protocol.swidge(h.options), error => {
    assertFreshnessError(error, 1255)
    return true
  })
  assert.deepEqual(h.sent, [])
})

for (const [at, initial, expected, failedType] of [
  ['reset', amount + 1n, ['approve:0'], 'approval'],
  ['amount', 0n, [`approve:${amount}`], 'source'],
  ['amount', amount + 1n, ['approve:0', `approve:${amount}`], 'source'],
  ['delayed-allowance', 0n, [`approve:${amount}`], 'source']
] as const) {
  it(`preserves broadcasts when ${at} from allowance ${initial} consumes the margin`, async t => {
    if (at === 'delayed-allowance') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const h = evmHarness({ initial, at })
    const failure = assert.rejects(h.protocol.swidge(h.options), error => {
      assertError(error, ButterPartialExecutionError,
        `Butter execution failed after broadcasting ${expected.length} transaction(s); do not retry without inspecting them`)
      assertFreshnessError(error.cause, 1255)
      assert.equal(error.failedType, failedType)
      assert.deepEqual(error.transactions, expected.map((_, i) => ({ hash: dummyHash(i + 1), chain: '56', type: 'approval' })))
      return true
    })
    if (at === 'delayed-allowance') {
      await flushAsyncWork()
      t.mock.timers.tick(2000)
    }
    await failure
    assert.deepEqual(h.sent, expected)
    assert.deepEqual(h.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

it('keeps the original local expiry when the route omits its timestamp', async () => {
  const h = evmHarness({ timestamp: false, at: 'read', time: 1301 })
  await assert.rejects(h.protocol.swidge(h.options), error => {
    assertFreshnessError(error, 1301)
    return true
  })
  assert.deepEqual(h.sent, [])
})

it('records a final send that returns after expiry without retroactively rejecting it', async () => {
  const h = evmHarness({ at: 'sender', time: 1301 })
  const result = await h.protocol.swidge(h.options)
  assert.deepEqual(result.transactions, [{ hash: dummyHash(1), chain: '56', type: 'source' }])
  assert.deepEqual(h.sent, ['source'])
})

for (const stopAt of ['swap', 'adapter', 'source', 'other', 'none'] as const) {
  it(`checks adapter sends and preserves status routing when stopping at ${stopAt}`, async () => {
    const chain = '1360095883558913'
    let now = 1000
    const sent: string[] = []
    const baseFetch = threeTxAdapterFetch(chain, chain)
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => 'btc-sender',
      getTransactionReceipt: async transactionHash => ({ transactionHash, status: 'success' }),
      sendTransaction: async tx => {
        const to = (tx as { to: string }).to
        sent.push(to)
        if (stopAt === 'source' || (stopAt === 'other' && sent.length === 2)) now = 1301
        return { hash: dummyHash(sent.length), fee: 10n }
      }
    }, {
      sourceChainId: chain, entrance: 'wdk', now: () => now,
      fetch: async (url, init) => {
        const result = await baseFetch(url, init)
        if (stopAt === 'swap' && new URL(url).pathname === '/swap') now = 1301
        return result
      },
      transactionAdapters: { [chain]: tx => {
        if (stopAt === 'adapter') now = 1301
        return threeTxAdapter(tx)
      } }
    })
    const execution = protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: chain, recipient: 'btc-recipient', fromTokenAmount: 100000000n })
    const count = stopAt === 'source' ? 1 : stopAt === 'other' ? 2 : 0
    if (stopAt === 'none') {
      const result = await execution
      assert.equal(result.id, dummyHash(2))
      assert.deepEqual(sent, ['btc-approval', 'btc-deposit', 'btc-followup'])
    } else {
      await assert.rejects(execution, error => {
        if (count === 0) assertFreshnessError(error, 1301)
        else {
          assertError(error, ButterPartialExecutionError,
            `Butter execution failed after broadcasting ${count} transaction(s); do not retry without inspecting them`)
          assertFreshnessError(error.cause, 1301)
          assert.equal(error.failedType, stopAt)
          assert.deepEqual(error.transactions, [
            { hash: dummyHash(1), chain, type: 'approval' }, { hash: dummyHash(2), chain, type: 'source' }
          ].slice(0, count))
        }
        return true
      })
      assert.deepEqual(sent, ['btc-approval', 'btc-deposit'].slice(0, count))
      if (stopAt === 'other') {
        const status = await protocol.getSwidgeStatus(dummyHash(2))
        assert.equal(status.status, 'completed')
      }
    }
    assert.deepEqual(baseFetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}
