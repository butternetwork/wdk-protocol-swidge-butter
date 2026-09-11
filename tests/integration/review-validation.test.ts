import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol, { type EvmPublicClient } from '../../src/index.ts'
import {
  makeFetch, quoteRoute, ERC20_TOKEN, DEST_TOKEN, VALID_SENDER,
  VALID_RECIPIENT, ROUTER, SOLANA_CHAIN_ID, dummyHash, sameChainSwapDataFor
} from '../helpers/protocol-fixtures.ts'

const amount = 100000000n
const options = {
  fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 56,
  recipient: VALID_RECIPIENT, fromTokenAmount: amount, slippage: 0.02
}
const config = {
  sourceChainId: 56, entrance: 'wdk', now: () => 1000,
  tokenDecimals: { [ERC20_TOKEN]: 6 }
}

function route (overrides: Record<string, unknown> = {}) {
  return quoteRoute({
    timestamp: 1000, bridgeFee: undefined, gasFee: undefined, dstChain: undefined,
    swapFee: { nativeFee: '0', tokenFee: '0.02' },
    srcChain: {
      chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 6 },
      tokenOut: { address: DEST_TOKEN, decimals: 6 },
      totalAmountIn: '100', totalAmountOut: '9.5'
    },
    ...overrides
  })
}

function executionFetch (overrides: Record<string, unknown> = {}) {
  return makeFetch({
    '/route': () => ({ errno: 0, data: [route(overrides)] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: '0', chainId: '56', data: sameChainSwapDataFor(ERC20_TOKEN, amount)
    }] })
  })
}

for (const metadata of [
  {}, { decimals: '' }, { decimals: ' ' }, { decimals: false }, { decimals: [] },
  { decimals: -1 }, { decimals: 256 }, { decimals: 1.5 }, { decimals: '1e2' },
  { decimals: 6, decimal: false }
]) {
  it(`does not seed invalid catalog precision ${JSON.stringify(metadata)} into fee valuation`, async () => {
    let sends = 0
    const fetch = makeFetch({
      '/supportedTokenList': () => ({ errno: 0, data: [{
        chainId: '56', tokens: [{ address: ERC20_TOKEN, ...metadata }]
      }] }),
      '/findToken': (url) => {
        assert.deepEqual(Object.fromEntries(url.searchParams), { chainId: '56', address: ERC20_TOKEN })
        return { errno: 0, data: [{ chainId: '56', address: ERC20_TOKEN, decimals: 6 }] }
      },
      '/route': (url) => {
        assert.equal(url.searchParams.get('amount'), '100')
        return { errno: 0, data: [route({ swapFee: { nativeFee: '0', tokenFee: '10' } })] }
      }
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => VALID_SENDER,
      sendTransaction: async () => { sends++; return dummyHash(1) }
    }, { ...config, fetch, tokenDecimals: {}, maxProtocolFeeBps: 1 })

    const tokens = await protocol.getSupportedTokens()
    await assert.rejects(protocol.swidge(options), {
      name: 'ButterFeeLimitExceededError', message: 'Butter protocol fee exceeds the configured limit'
    })

    assert.deepEqual(tokens, [])
    assert.equal(sends, 0)
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedTokenList', '/findToken', '/route'])
  })
}

it('rejects catalog alias conflicts without caching earlier valid entries', async () => {
  const fetch = makeFetch({
    '/supportedTokenList': () => ({ errno: 0, data: [{ chainId: '56', tokens: [
      { address: ERC20_TOKEN, decimals: 0 },
      { address: DEST_TOKEN, decimals: 0, decimal: 6 }
    ] }] }),
    '/findToken': () => ({ errno: 0, data: [{ chainId: '56', address: ERC20_TOKEN, decimals: 6 }] }),
    '/route': (url) => {
      assert.equal(url.searchParams.get('amount'), '100')
      return { errno: 0, data: [route()] }
    }
  })
  const protocol = new ButterSwidgeProtocol(undefined, { ...config, fetch, tokenDecimals: {} })

  await assert.rejects(protocol.getSupportedTokens(), {
    name: 'ButterApiError', message: 'Butter supported-token list returned conflicting decimals for the same token'
  })
  const quote = await protocol.quoteSwidge(options)

  assert.equal(quote.fromTokenAmount, amount)
  assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedTokenList', '/findToken', '/route'])
})

for (const metadata of [{ decimals: 0 }, { decimal: '0' }, { decimals: ' 0 ', decimal: 0 }]) {
  it(`preserves valid zero catalog precision ${JSON.stringify(metadata)}`, async () => {
    const fetch = makeFetch({
      '/supportedTokenList': () => ({ errno: 0, data: [{
        chainId: '56', tokens: [{ address: ERC20_TOKEN, symbol: 'ZERO', ...metadata }]
      }] }),
      '/route': (url) => {
        assert.equal(url.searchParams.get('amount'), '100000000')
        return { errno: 0, data: [route({
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: {
            chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 0 },
            tokenOut: { address: DEST_TOKEN, decimals: 6 },
            totalAmountIn: '100000000', totalAmountOut: '9.5'
          }
        })] }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { ...config, fetch, tokenDecimals: {} })

    const tokens = await protocol.getSupportedTokens()
    const quote = await protocol.quoteSwidge(options)

    assert.deepEqual(tokens, [{ token: ERC20_TOKEN, address: ERC20_TOKEN, chain: '56', symbol: 'ZERO', decimals: 0 }])
    assert.equal(quote.fromTokenAmount, amount)
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedTokenList', '/route'])
  })
}

for (const confirmations of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  it(`rejects invalid approval confirmation count ${confirmations}`, () => {
    assert.throws(() => new ButterSwidgeProtocol(undefined, {
      ...config, evm: { approvalConfirmations: confirmations }
    }), { name: 'ButterConfigurationError', message: 'approvalConfirmations must be a positive safe integer' })
  })
}

for (const readAllowance of [false, true]) {
  it(`refuses multiple approval confirmations before broadcasting with allowance reader ${readAllowance}`, async () => {
    let sends = 0
    let receipts = 0
    const fetch = executionFetch()
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => VALID_SENDER,
      sendTransaction: async () => { sends++; return dummyHash(1) },
      getTransactionReceipt: async () => { receipts++; return { status: 1, confirmations: 1 } }
    }, {
      ...config, fetch, evm: {
        approvalConfirmations: 12,
        ...(readAllowance ? { publicClient: { readContract: async () => amount + 1n } } : {})
      }
    })

    await assert.rejects(protocol.swidge(options), {
      name: 'ButterConfigurationError', message: 'Multiple approval confirmations require evm.publicClient.waitForTransactionReceipt'
    })

    assert.equal(sends, 0)
    assert.equal(receipts, 0)
  })
}

for (const mode of ['account default', 'public waiter', 'exact allowance'] as const) {
  it(`executes with the supported approval policy: ${mode}`, async () => {
    let sends = 0
    const receiptQueries: unknown[] = []
    const publicClient: EvmPublicClient = {
      readContract: async () => mode === 'exact allowance' ? amount : 0n,
      ...(mode === 'public waiter' ? {
        waitForTransactionReceipt: async (args: { hash: string, confirmations?: number, timeout?: number }) => {
          receiptQueries.push(args)
          return { status: 'success' }
        }
      } : {})
    }
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => VALID_SENDER,
      sendTransaction: async () => ({ hash: dummyHash(++sends) }),
      getTransactionReceipt: async (hash) => { receiptQueries.push(hash); return { status: 1 } }
    }, {
      ...config, fetch: executionFetch(),
      evm: mode === 'account default' ? {} : { publicClient, approvalConfirmations: 12 }
    })

    const result = await protocol.swidge(options)

    assert.equal(sends, mode === 'exact allowance' ? 1 : 2)
    assert.deepEqual(result.transactions?.map(({ type }) => type), mode === 'exact allowance' ? ['source'] : ['approval', 'source'])
    assert.deepEqual(receiptQueries, mode === 'account default' ? [dummyHash(1)] : mode === 'public waiter'
      ? [{ hash: dummyHash(1), confirmations: 12, timeout: 10000 }] : [])
  })
}

for (const [mode, margin] of [['quote', 15], ['execute', 45]] as const) {
  for (const remaining of [-1, 0, margin - 1, margin, margin + 1]) {
    it(`${mode} checks a new route with ${remaining} seconds remaining`, async () => {
      let sends = 0
      const fetch = executionFetch({ timestamp: 1000 + remaining - 300 })
      const protocol = new ButterSwidgeProtocol({
        getAddress: () => VALID_SENDER,
        sendTransaction: async () => ({ hash: dummyHash(++sends) }),
        getTransactionReceipt: async () => ({ status: 1 })
      }, { ...config, fetch })

      if (remaining <= margin) {
        await assert.rejects(mode === 'quote' ? protocol.quoteSwidge(options) : protocol.swidge(options), {
          name: 'ButterActionRequiredError', message: 'Butter quote expires too soon; request a new quote'
        })
        assert.equal(sends, 0)
        assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route'])
      } else if (mode === 'quote') {
        const quote = await protocol.quoteSwidge(options)
        assert.equal(quote.expiry, 1000 + remaining)
        assert.equal(quote.destinationGuarantees, 'enforced')
        assert.equal(sends, 0)
      } else {
        const result = await protocol.swidge(options)
        assert.equal(result.id, dummyHash(2))
        assert.equal(sends, 2)
      }
    })
  }
}

for (const margin of [0, 20, 60]) {
  it(`applies a custom ${margin}-second execution window to newly fetched routes`, async () => {
    let remaining = margin
    let sends = 0
    const fetch = makeFetch({
      '/route': () => ({ errno: 0, data: [route({ timestamp: 1000 + remaining - 300 })] }),
      '/swap': () => ({ errno: 0, data: [{
        to: ROUTER, value: '0', chainId: '56', data: sameChainSwapDataFor(ERC20_TOKEN, amount)
      }] })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => VALID_SENDER,
      sendTransaction: async () => ({ hash: dummyHash(++sends) }),
      getTransactionReceipt: async () => ({ status: 1 })
    }, { ...config, fetch, routeExecutionMarginSeconds: margin })

    await assert.rejects(protocol.swidge(options), {
      name: 'ButterActionRequiredError', message: 'Butter quote expires too soon; request a new quote'
    })
    assert.equal(sends, 0)
    remaining++
    const result = await protocol.swidge(options)

    assert.equal(result.id, dummyHash(2))
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route', '/route', '/swap'])
  })
}

it('does not cache or pin a rejected fresh quote', async () => {
  let timestamp = 700
  const quoteFetch = makeFetch({
    '/route': () => ({ errno: 0, data: [route({ timestamp })] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    sendTransaction: async () => { throw new Error('Rejected quote must never send') }
  }, { ...config, fetch: quoteFetch })

  await assert.rejects(protocol.quoteSwidge(options), {
    name: 'ButterActionRequiredError', message: 'Butter quote expires too soon; request a new quote'
  })
  await assert.rejects(protocol.swidge({ ...options, routeHash: route().hash }), {
    name: 'ButterActionRequiredError',
    message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
  })
  timestamp = 1000
  const quote = await protocol.quoteSwidge(options)

  assert.equal(quote.expiry, 1300)
  assert.deepEqual(quoteFetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
})

for (const state of [[1], ['completed'], {}, false, '__proto__', 'constructor', 999]) {
  it(`treats malformed or unknown Butter state ${JSON.stringify(state)} as pending`, async () => {
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': () => ({ code: 200, data: { info: { state, sourceHash: dummyHash(1) } } })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { ...config, fetch })

    const result = await protocol.getSwidgeStatus(dummyHash(1))

    assert.deepEqual(result, { status: 'pending', transactions: [{ hash: dummyHash(1), type: 'source' }] })
  })
}

const solanaReceipts: { label: string, receipt: unknown, status: string }[] = [
  { label: 'success', receipt: { slot: 12345, meta: { err: null, fee: 5000 } }, status: 'completed' },
  { label: 'instruction error', receipt: { meta: { err: { InstructionError: [0, { Custom: 1 }] } } }, status: 'failed' },
  { label: 'string error', receipt: { meta: { err: 'AccountNotFound' } }, status: 'failed' },
  { label: 'not found', receipt: null, status: 'pending' },
  { label: 'missing error', receipt: { meta: {} }, status: 'pending' },
  { label: 'invalid error', receipt: { meta: { err: false } }, status: 'pending' },
  { label: 'empty error object', receipt: { meta: { err: {} } }, status: 'pending' },
  { label: 'array error', receipt: { meta: { err: [] } }, status: 'pending' },
  { label: 'missing metadata', receipt: { slot: 12345 }, status: 'pending' },
  { label: 'invalid metadata overrides status', receipt: { meta: null, status: 1 }, status: 'pending' },
  { label: 'native error overrides status', receipt: { meta: { err: 'AccountNotFound' }, status: 1 }, status: 'failed' },
  { label: 'normalized success', receipt: { status: 1 }, status: 'completed' },
  { label: 'normalized failure', receipt: { status: 0 }, status: 'failed' }
]

for (const { label, receipt, status } of solanaReceipts) {
  it(`reports Solana same-chain ${label} after adapter execution`, async () => {
    const sender = '11111111111111111111111111111111'
    const mint = 'So11111111111111111111111111111111111111112'
    const sent: unknown[] = []
    const queried: string[] = []
    const fetch = makeFetch({
      '/route': () => ({ errno: 0, data: [route({
        srcChain: {
          chainId: SOLANA_CHAIN_ID, tokenIn: { address: 'sol', decimals: 9 },
          tokenOut: { address: mint, decimals: 9 },
          totalAmountIn: '1', totalAmountOut: '9.5'
        },
        swapFee: { nativeFee: '0', tokenFee: '0' }
      })] }),
      '/swap': () => ({ errno: 0, data: [{ to: sender, data: 'opaque', value: '0', chainId: SOLANA_CHAIN_ID }] })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: () => sender,
      sendTransaction: async (tx) => { sent.push(tx); return 'solana-source-signature' },
      getTransactionReceipt: async (hash) => { queried.push(hash); return receipt }
    }, {
      sourceChainId: SOLANA_CHAIN_ID, entrance: 'wdk', referrer: 'wdk-test', fetch, now: () => 1000,
      transactionAdapters: { [SOLANA_CHAIN_ID]: () => ({ transaction: { minimumOutput: 0n }, type: 'source' }) },
      evm: { publicClient: {
        readContract: async () => 0n,
        getTransactionReceipt: async () => { throw new Error('Solana must use its account receipt') }
      } }
    })
    const solanaOptions = {
      fromToken: 'sol', toToken: mint, toChain: SOLANA_CHAIN_ID,
      fromTokenAmount: 1000000000n, recipient: sender, slippage: 0.02
    }

    const quote = await protocol.quoteSwidge(solanaOptions)
    const result = await protocol.swidge({ ...solanaOptions, routeHash: quote.routeHash })
    const actual = await protocol.getSwidgeStatus(result.id)

    assert.equal(quote.destinationGuarantees, 'quoted-only')
    assert.equal(quote.toTokenAmountMin, 9500000000n)
    assert.deepEqual(sent, [{ minimumOutput: 0n }])
    assert.deepEqual(queried, ['solana-source-signature'])
    assert.deepEqual(actual, {
      status,
      transactions: receipt == null ? [] : [{ hash: result.id, chain: SOLANA_CHAIN_ID, type: 'source' }]
    })
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

for (const gasFee of [undefined, { amount: '0', symbol: 'BNB' }, { amount: '0.0001', symbol: 'BNB' }]) {
  for (const reported of [0n, 12345n]) {
    it(`retains sender network fee ${reported} with gas metadata ${JSON.stringify(gasFee)}`, async () => {
      const protocol = new ButterSwidgeProtocol({
        getAddress: () => VALID_SENDER,
        sendTransaction: async () => ({ hash: dummyHash(1), fee: reported })
      }, {
        ...config, fetch: executionFetch({ gasFee }),
        evm: { publicClient: { readContract: async () => amount } }
      })

      const result = await protocol.swidge(options)

      assert.deepEqual(result.fees.filter(({ type }) => type === 'network'), [{
        type: 'network', amount: reported, token: gasFee ? 'BNB' : 'native',
        chain: '56', included: false, description: 'Sender-reported source gas fee'
      }])
      assert.deepEqual(result.fees.filter(({ type }) => type === 'protocol').map(({ amount }) => amount), [20000n])
    })
  }
}
