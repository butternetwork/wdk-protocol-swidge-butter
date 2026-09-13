import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol from '../../src/index.ts'
import {
  makeFetch, quoteRoute, NATIVE_TOKEN, ERC20_TOKEN, DEST_TOKEN, ROUTER,
  VALID_SENDER, VALID_RECIPIENT, dummyHash, sameChainSwapDataFor, crossChainSwapData
} from '../helpers/protocol-fixtures.ts'

const aliases = ['native', ' NaTiVe ', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', NATIVE_TOKEN]
const amount = 1500000000000000000n

function quoteSetup (
  sourceChain: string, destinationChain: string, sourceToken: string, destinationToken: string,
  evmChainIds: (string | number)[] = []
) {
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      hash: 'native-quote', bridgeFee: undefined, swapFee: { nativeFee: '0', tokenFee: '0' },
      srcChain: {
        chainId: sourceChain, tokenIn: { address: sourceToken, decimals: 18 },
        tokenOut: { address: destinationToken, decimals: 18 }, totalAmountIn: '1.5', totalAmountOut: '1'
      },
      dstChain: sourceChain === destinationChain ? undefined : {
        chainId: destinationChain, tokenOut: { address: destinationToken, decimals: 18 }, totalAmountOut: '1'
      },
      minAmountOut: { amount: '1' }
    })] })
  })
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId: sourceChain, entrance: 'wdk', fetch, now: () => 1000, evmChainIds,
    tokenDecimals: { [ERC20_TOKEN]: 18 }, referrer: 'test'
  })
  return { protocol, fetch }
}

for (const alias of aliases) {
  for (const destination of ['56', '137']) {
    for (const direction of ['input', 'output'] as const) {
      it(`encodes EVM native ${direction} ${alias} as zero address for 56 -> ${destination}`, async () => {
        const nativeInput = direction === 'input'
        const { protocol, fetch } = quoteSetup('56', destination,
          nativeInput ? NATIVE_TOKEN : ERC20_TOKEN, nativeInput ? DEST_TOKEN : NATIVE_TOKEN)

        const quote = await protocol.quoteSwidge({
          fromToken: nativeInput ? alias : ERC20_TOKEN, toToken: nativeInput ? DEST_TOKEN : alias,
          toChain: destination, fromTokenAmount: amount, slippage: 0.02
        })

        assert.equal(quote.fromTokenAmount, amount)
        assert.equal(quote.toTokenAmount, 1000000000000000000n)
        assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route'])
        assert.equal(fetch.calls[0]?.url.searchParams.get('tokenInAddress'), nativeInput ? NATIVE_TOKEN : ERC20_TOKEN)
        assert.equal(fetch.calls[0]?.url.searchParams.get('tokenOutAddress'), nativeInput ? DEST_TOKEN : NATIVE_TOKEN)
        assert.equal(fetch.calls[0]?.url.searchParams.get('amount'), '1.5')
      })
    }
  }
}

for (const [chain, expected, extraChains] of [
  ['1', NATIVE_TOKEN, []],
  ['123456', NATIVE_TOKEN, [123456]],
  ['123456', 'native', []],
  ['1360108768460801', 'So11111111111111111111111111111111111111112', []],
  ['728126428', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', []],
  ['1360095883558913', NATIVE_TOKEN, []]
] as const) {
  for (const direction of ['input', 'output']) {
    it(`preserves chain-specific native encoding on ${chain}, ${direction}, extra EVM chains ${extraChains}`, async () => {
      const nativeInput = direction === 'input'
      const destination = nativeInput ? '56' : chain
      const { protocol, fetch } = quoteSetup(nativeInput ? chain : '56', destination,
        nativeInput ? expected : ERC20_TOKEN, nativeInput ? DEST_TOKEN : expected, [...extraChains])

      await protocol.quoteSwidge({
        fromToken: nativeInput ? 'native' : ERC20_TOKEN, toToken: nativeInput ? DEST_TOKEN : 'native',
        toChain: destination, fromTokenAmount: amount, recipient: VALID_RECIPIENT, slippage: 0.03
      })

      assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route'])
      assert.equal(fetch.calls[0]?.url.searchParams.get(nativeInput ? 'tokenInAddress' : 'tokenOutAddress'), expected)
    })
  }
}

it('retains ERC20 address casing while encoding the native destination', async () => {
  const token = '0x00000000000000000000000000000000000000aA'
  const { protocol, fetch } = quoteSetup('56', '56', ERC20_TOKEN, NATIVE_TOKEN)

  await protocol.quoteSwidge({ fromToken: token, toToken: 'native', fromTokenAmount: amount })

  assert.equal(fetch.calls[0]?.url.searchParams.get('tokenInAddress'), token)
  assert.equal(fetch.calls[0]?.url.searchParams.get('tokenOutAddress'), NATIVE_TOKEN)
})

it('shares the quote cache across equivalent EVM native destination aliases', async () => {
  const { protocol, fetch } = quoteSetup('56', '137', ERC20_TOKEN, NATIVE_TOKEN)
  const hashes: string[] = []

  for (const toToken of aliases) {
    const quote = await protocol.quoteSwidge({
      fromToken: ERC20_TOKEN, toToken, toChain: 137, fromTokenAmount: amount, slippage: 0.02
    })
    hashes.push(quote.routeHash)
  }

  assert.deepEqual(hashes, aliases.map(() => 'native-quote'))
  assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route'])
  assert.equal(fetch.calls[0]?.url.searchParams.get('tokenOutAddress'), NATIVE_TOKEN)
})

function executionSetup (crossChain = false, invalid?: 'token' | 'amount' | 'fee') {
  const destination = crossChain ? '137' : '56'
  const sourceToken = invalid === 'token' ? ERC20_TOKEN : NATIVE_TOKEN
  const encodedAmount = invalid === 'amount' ? amount + 1n : amount
  const data = crossChain
    ? crossChainSwapData(sourceToken, encodedAmount)
    : sameChainSwapDataFor(sourceToken, encodedAmount)
  const value = invalid === 'fee' ? amount + 1n : amount
  const sent: unknown[] = []
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      hash: 'native-execution', bridgeFee: undefined, swapFee: { nativeFee: '0', tokenFee: '0' },
      srcChain: {
        chainId: '56', tokenIn: { address: NATIVE_TOKEN, decimals: 18 },
        tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountIn: '1.5', totalAmountOut: '9.5'
      },
      dstChain: crossChain ? {
        chainId: destination, tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '9.5'
      } : undefined
    })] }),
    '/swap': () => ({ errno: 0, data: [{ to: ROUTER, value: String(value), data, chainId: '56' }] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    getAllowance: async () => { throw new Error('Native swaps must not read allowances') },
    sendTransaction: async tx => { sent.push(tx); return dummyHash(1) }
  }, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => 1000, maxNativeFee: 0n })
  const options = {
    fromToken: 'native', toToken: DEST_TOKEN, toChain: destination,
    fromTokenAmount: amount, recipient: VALID_RECIPIENT, slippage: 0.02
  }
  return { protocol, fetch, sent, options, data, value }
}

for (const crossChain of [false, true]) {
  for (const pinned of [false, true]) {
    it(`executes native aliases with crossChain=${crossChain}, pinned=${pinned}`, async () => {
      const { protocol, fetch, sent, options, data, value } = executionSetup(crossChain)
      let routeHash: string | undefined
      if (pinned) {
        const quote = await protocol.quoteSwidge(options)
        const cached = await protocol.quoteSwidge({ ...options, fromToken: NATIVE_TOKEN })
        assert.equal(cached.routeHash, quote.routeHash)
        routeHash = quote.routeHash
      }

      const result = await protocol.swidge({
        ...options, fromToken: aliases[2]!, ...(routeHash != null ? { routeHash } : {})
      })

      assert.equal(result.id, dummyHash(1))
      assert.equal(result.fromTokenAmount, amount)
      assert.deepEqual(result.transactions, [{ hash: dummyHash(1), chain: '56', type: 'source' }])
      assert.deepEqual(sent, [{ to: ROUTER, value, data, chainId: 56 }])
      assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
      assert.equal(fetch.calls[0]?.url.searchParams.get('tokenInAddress'), NATIVE_TOKEN)
      assert.equal(fetch.calls[1]?.url.searchParams.get('hash'), 'native-execution')
    })
  }
}

for (const [invalid, message] of [
  ['token', 'Butter Router source token does not match quote'],
  ['amount', 'Butter Router source amount does not match quote'],
  ['fee', 'Butter /swap native fee exceeds the configured maxNativeFee']
] as const) {
  it(`rejects invalid native ${invalid} after canonical request encoding`, async () => {
    const { protocol, options, sent } = executionSetup(false, invalid)

    await assert.rejects(protocol.swidge(options), { name: 'ButterTransactionValidationError', message })

    assert.deepEqual(sent, [])
  })
}
