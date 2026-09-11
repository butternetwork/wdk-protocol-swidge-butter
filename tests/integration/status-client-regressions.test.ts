import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol, { type EvmPublicClient } from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, DEST_TOKEN, VALID_SENDER,
  VALID_RECIPIENT, ROUTER, SOLANA_CHAIN_ID, sameChainSwapDataFor, dummyHash
} from '../helpers/protocol-fixtures.ts'

const amount = 1500000000000000000n
const hash = dummyHash(1)
const transaction = {
  to: ROUTER, value: String(amount), chainId: '56',
  data: sameChainSwapDataFor(NATIVE_TOKEN, amount)
}

class StatefulClient implements EvmPublicClient {
  readonly transactionQueries: string[] = []
  readonly receiptQueries: string[] = []

  async readContract () { return 0n }

  async getTransaction (id: string) {
    this.transactionQueries.push(id)
    return { to: ROUTER, input: transaction.data }
  }

  async getTransactionReceipt (id: string) {
    this.receiptQueries.push(id)
    return { status: 'success' as const }
  }
}

it('preserves the public client context when attributing an unrecorded same-chain transaction', async () => {
  const publicClient = new StatefulClient()
  const fetch = makeFetch({})
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId: 56, entrance: 'wdk', fetch, evm: { publicClient }
  })

  const result = await protocol.getSwidgeStatus(hash, { fromChain: 56, toChain: '56' })

  assert.deepEqual(result, {
    status: 'completed', transactions: [{ hash, chain: '56', type: 'source' }]
  })
  assert.deepEqual(publicClient.transactionQueries, [hash])
  assert.deepEqual(publicClient.receiptQueries, [hash])
  assert.equal(fetch.calls.length, 0)
})

type StatusOrigin = 'recorded EVM' | 'attributed EVM' | 'recorded Solana'

async function statusHarness (origin: StatusOrigin) {
  const solana = origin === 'recorded Solana'
  const chain = solana ? SOLANA_CHAIN_ID : '56'
  const sender = solana ? '11111111111111111111111111111111' : VALID_SENDER
  const fromToken = solana ? 'sol' : NATIVE_TOKEN
  const toToken = solana ? 'So11111111111111111111111111111111111111112' : DEST_TOKEN
  const recipient = solana ? sender : VALID_RECIPIENT
  const publicClient = new StatefulClient()
  const accountReceipts: string[] = []
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      dstChain: undefined, bridgeFee: undefined, gasFee: undefined,
      swapFee: { nativeFee: '0', tokenFee: '0' },
      srcChain: {
        chainId: chain,
        tokenIn: { address: fromToken, decimals: solana ? 9 : 18 },
        tokenOut: { address: toToken, decimals: solana ? 9 : 6 },
        totalAmountIn: solana ? '1' : '1.5', totalAmountOut: '9.5'
      }
    })] }),
    '/swap': () => ({ errno: 0, data: [solana
      ? { to: sender, value: '0', chainId: chain, data: 'opaque' }
      : transaction] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => sender,
    sendTransaction: async () => hash,
    getTransactionReceipt: async (id) => {
      accountReceipts.push(id)
      return { meta: { err: null } }
    }
  }, {
    sourceChainId: chain, entrance: 'wdk', fetch, referrer: 'wdk-test',
    evm: { publicClient },
    ...(solana ? { transactionAdapters: { [chain]: () => ({ transaction: { payload: 'swap' }, type: 'source' as const }) } } : {})
  })
  if (origin !== 'attributed EVM') {
    await protocol.swidge({
      fromToken, toToken, toChain: chain, recipient,
      fromTokenAmount: solana ? 1000000000n : amount
    })
  }
  return { protocol, chain, publicClient, accountReceipts, fetch }
}

for (const origin of ['recorded EVM', 'attributed EVM', 'recorded Solana'] as const) {
  for (const field of ['fromChain', 'toChain'] as const) {
    it(`rejects a conflicting ${field} before reading the ${origin} receipt`, async () => {
      const test = await statusHarness(origin)
      const hints = { fromChain: test.chain, toChain: test.chain, [field]: 1 }
      const httpCalls = test.fetch.calls.length

      await assert.rejects(test.protocol.getSwidgeStatus(hash, hints), {
        name: 'ButterApiError',
        message: `Butter status ${field === 'fromChain' ? 'source' : 'destination'} chain does not match request hints`,
        details: { id: hash, chain: test.chain }
      })

      assert.deepEqual(test.publicClient.receiptQueries, [])
      assert.deepEqual(test.accountReceipts, [])
      assert.equal(test.fetch.calls.length, httpCalls)
    })
  }

  it(`accepts absent and equivalent numeric/string chain hints for ${origin}`, async () => {
    const test = await statusHarness(origin)
    const expected = {
      status: 'completed', transactions: [{ hash, chain: test.chain, type: 'source' }]
    }

    assert.deepEqual(await test.protocol.getSwidgeStatus(hash), expected)
    assert.deepEqual(await test.protocol.getSwidgeStatus(hash, {
      fromChain: Number(test.chain), toChain: test.chain
    }), expected)

    assert.deepEqual(origin === 'recorded Solana' ? test.accountReceipts : test.publicClient.receiptQueries, [hash, hash])
  })
}
