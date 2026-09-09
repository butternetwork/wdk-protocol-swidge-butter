import { it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeFunctionData, zeroHash, type Hex } from 'viem'
import ButterSwidgeProtocol from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, DEST_TOKEN, VALID_SENDER,
  VALID_RECIPIENT, ROUTER, routerV3Abi, swapParamAbi, dummyHash
} from '../helpers/protocol-fixtures.ts'

const amount = 1500000000000000000n
const options = {
  fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 56,
  recipient: VALID_RECIPIENT, fromTokenAmount: amount, slippage: 0.02
}

function route (timestamp = 1000, hash = dummyHash(1), fromToken = NATIVE_TOKEN, toToken = DEST_TOKEN) {
  return quoteRoute({
    timestamp, hash, gasFee: undefined, bridgeFee: undefined,
    swapFee: { nativeFee: '0', tokenFee: '0' }, dstChain: undefined,
    srcChain: {
      chainId: '56', tokenIn: { address: fromToken, decimals: 18 },
      tokenOut: { address: toToken, decimals: 6 },
      totalAmountIn: '1.5', totalAmountOut: '10.25'
    }
  })
}

function transaction (source: Hex = NATIVE_TOKEN, destination: Hex = DEST_TOKEN) {
  const swapData = encodeAbiParameters(swapParamAbi, [{
    dstToken: destination, receiver: VALID_RECIPIENT, leftReceiver: VALID_SENDER,
    minAmount: 9500000n, swaps: []
  }])
  return {
    to: ROUTER, value: String(amount), chainId: '56',
    data: encodeFunctionData({
      abi: routerV3Abi, functionName: 'swapAndCall',
      args: [zeroHash, VALID_SENDER, source, amount, swapData, '0x', '0x', '0x']
    })
  }
}

for (const scenario of ['wrong options', 'replaced hash'] as const) {
  it(`preserves an executable quote after ${scenario}`, async () => {
    let now = 1000
    let routeCalls = 0
    let sends = 0
    const fetch = makeFetch({
      '/route': async () => {
        const call = ++routeCalls
        const timestamp = now
        return { errno: 0, data: [route(timestamp, dummyHash(call))] }
      },
      '/swap': () => ({ errno: 0, data: [transaction()] })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => VALID_SENDER,
      sendTransaction: async () => { sends++; return { hash: dummyHash(10) } }
    }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => now })

    const first = await protocol.quoteSwidge(options)
    let validHash = first.routeHash
    if (scenario === 'wrong options') {
      await assert.rejects(protocol.swidge({ ...options, fromTokenAmount: amount + 1n, routeHash: validHash }), {
        name: 'ButterActionRequiredError',
        message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
      })
    } else {
      now = 1286
      validHash = (await protocol.quoteSwidge(options)).routeHash
      await assert.rejects(protocol.swidge({ ...options, routeHash: first.routeHash }), {
        name: 'ButterActionRequiredError',
        message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
      })
    }
    assert.equal(sends, 0)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
    const result = await protocol.swidge({ ...options, routeHash: validHash })
    await assert.rejects(protocol.swidge({ ...options, routeHash: validHash }), {
      name: 'ButterActionRequiredError',
      message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
    })

    assert.equal(result.id, dummyHash(10))
    assert.equal(sends, 1)
    assert.equal(routeCalls, scenario === 'wrong options' ? 1 : 2)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 1)
  })
}

for (const [firstCompleted, lastCompleted] of [[0, 1], [1, 0]] as const) {
  it(`keeps the last completed quote when request ${firstCompleted + 1} finishes before request ${lastCompleted + 1}`, { timeout: 5000 }, async () => {
    let routeCalls = 0
    let sends = 0
    const releases: Array<() => void> = []
    const gates = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve) }))
    let bothRequested!: () => void
    const started = new Promise<void>((resolve) => { bothRequested = resolve })
    const hashes = [dummyHash(1), dummyHash(2)] as const
    const expectedHash = hashes[lastCompleted]
    const fetch = makeFetch({
      '/route': async () => {
        const index = routeCalls++
        if (routeCalls === 2) bothRequested()
        await gates[index]
        return { errno: 0, data: [route(1000, hashes[index])] }
      },
      '/swap': () => ({ errno: 0, data: [transaction()] })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => VALID_SENDER,
      sendTransaction: async () => { sends++; return { hash: dummyHash(10) } }
    }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000 })

    const quotes = [protocol.quoteSwidge(options), protocol.quoteSwidge(options)] as const
    await started
    // Wait for the first cache write before releasing the other response.
    releases[firstCompleted]!()
    assert.equal((await quotes[firstCompleted]).routeHash, hashes[firstCompleted])
    releases[lastCompleted]!()
    assert.equal((await quotes[lastCompleted]).routeHash, expectedHash)
    assert.equal((await protocol.quoteSwidge(options)).routeHash, expectedHash)
    assert.equal(routeCalls, 2)

    await assert.rejects(protocol.swidge({ ...options, routeHash: hashes[firstCompleted] }), {
      name: 'ButterActionRequiredError',
      message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
    })
    assert.equal(sends, 0)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)

    const result = await protocol.swidge({ ...options, routeHash: expectedHash })
    await assert.rejects(protocol.swidge({ ...options, routeHash: expectedHash }), {
      name: 'ButterActionRequiredError',
      message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
    })

    assert.equal(result.id, dummyHash(10))
    assert.equal(sends, 1)
    assert.equal(routeCalls, 2)
    assert.deepEqual(fetch.calls.filter(({ url }) => url.pathname === '/swap').map(({ url }) => url.searchParams.get('hash')), [expectedHash])
    assert.equal(fetch.calls.length, 3)
  })
}

for (const token of ['sol', 'btc', 'trx']) {
  for (const side of ['source', 'destination'] as const) {
    it(`rejects BSC ${side} ${token} against native calldata before sending`, async () => {
      const sentinel = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      let sends = 0
      const fromToken = side === 'source' ? token : NATIVE_TOKEN
      const toToken = side === 'destination' ? token : DEST_TOKEN
      const fetch = makeFetch({
        '/route': () => ({ errno: 0, data: [route(1000, dummyHash(1), fromToken, toToken)] }),
        '/swap': () => ({ errno: 0, data: [transaction(
          side === 'source' ? sentinel : NATIVE_TOKEN,
          side === 'destination' ? sentinel : DEST_TOKEN
        )] })
      })
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => VALID_SENDER,
        sendTransaction: async () => { sends++; return { hash: dummyHash(10) } }
      }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000, tokenDecimals: { [token]: 18 } })

      await assert.rejects(protocol.swidge({ ...options, fromToken, toToken }), {
        name: 'ButterTransactionValidationError',
        message: `Butter Router ${side} token does not match quote`,
        details: { expected: token, actual: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' }
      })
      assert.equal(sends, 0)
    })
  }
}

for (const token of ['native', NATIVE_TOKEN, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x00000000000000000000000000000000000000aA']) {
  it(`accepts chain-valid token ${token} in same-chain calldata`, async () => {
    const native = token !== '0x00000000000000000000000000000000000000aA'
    const actual = native ? NATIVE_TOKEN : '0x00000000000000000000000000000000000000aa'
    const sent: unknown[] = []
    const tx = { ...transaction(actual, actual), value: native ? String(amount) : '0' }
    const fetch = makeFetch({
      '/route': () => ({ errno: 0, data: [route(1000, dummyHash(1), token, token)] }),
      '/swap': () => ({ errno: 0, data: [tx] })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => VALID_SENDER,
      sendTransaction: async (transaction) => { sent.push(transaction); return { hash: dummyHash(10) } }
    }, {
      sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000,
      tokenDecimals: { [token]: 18 },
      evm: { publicClient: { readContract: async () => amount } }
    })

    const result = await protocol.swidge({ ...options, fromToken: token, toToken: token })

    assert.equal(result.id, dummyHash(10))
    assert.equal(sent.length, 1)
    assert.equal((sent[0] as { data: string }).data, tx.data)
  })
}

for (const remaining of [45, 0]) {
  it(`refuses a pinned quote with ${remaining} seconds left without sending or re-quoting`, async () => {
    let now = 1000
    let sends = 0
    const fetch = makeFetch({ '/route': () => ({ errno: 0, data: [route()] }) })
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => VALID_SENDER,
      sendTransaction: async () => { sends++; return { hash: dummyHash(10) } }
    }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => now })
    const quote = await protocol.quoteSwidge(options)
    now = 1300 - remaining

    await assert.rejects(protocol.swidge({ ...options, routeHash: quote.routeHash }), {
      name: 'ButterActionRequiredError',
      message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote'
    })
    if (remaining > 0) {
      assert.equal((await protocol.quoteSwidge(options)).routeHash, quote.routeHash)
    }

    assert.equal(sends, 0)
    assert.equal(fetch.calls.length, 1)
  })
}

for (const body of [null, [], true, 7, 'invalid']) {
  it(`classifies the non-object Router envelope ${JSON.stringify(body)} as an API error`, async () => {
    const fetch = makeFetch({ '/route': () => body })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    await assert.rejects(protocol.quoteSwidge(options), {
      name: 'ButterApiError', message: 'Butter router request failed', details: body
    })
    assert.equal(fetch.calls.length, 1)
  })
}

for (const field of [{ hash: '0x2222' }, ['0x2222'], true, null, '0x2222', 2222]) {
  for (const byOrderId of [false, true]) {
    it(`maps status fields ${JSON.stringify(field)} with byOrderId=${byOrderId}`, async () => {
      const scalar = typeof field === 'string' || typeof field === 'number' ? String(field) : undefined
      const id = byOrderId ? 'order-1' : scalar ?? '0x1111'
      const endpoint = byOrderId ? '/api/queryCrossInfoByOrderId' : '/api/queryBridgeInfoBySourceHash'
      const fetch = makeFetch({
        [endpoint]: () => ({ code: 200, data: {
          state: 1, sourceHash: field, toHash: field,
          fromChain: { chainId: field }, toChainId: field
        } })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

      const result = await protocol.getSwidgeStatus(id, { byOrderId })

      assert.deepEqual(result, {
        status: 'completed',
        transactions: scalar !== undefined
          ? [{ hash: scalar, chain: scalar, type: 'source' }, { hash: scalar, chain: scalar, type: 'destination' }]
          : byOrderId ? [] : [{ hash: id, type: 'source' }]
      })
      assert.equal(fetch.calls.length, 1)
    })
  }
}
