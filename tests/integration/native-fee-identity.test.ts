import assert from 'node:assert/strict'
import { it } from 'node:test'
import { decodeFunctionData, erc20Abi } from 'viem'
import ButterSwidgeProtocol, { type ButterRoute } from '../../src/index.ts'
import {
  sameChainErc20Fetch, sameChainErc20Options, ERC20_TOKEN_DECIMALS,
  ERC20_TOKEN, DEST_TOKEN, NATIVE_TOKEN, VALID_SENDER, VALID_RECIPIENT,
  dummyHash, makeFetch, quoteRoute
} from '../helpers/protocol-fixtures.ts'

function executionHarness (gasFee: unknown, settings: {
  caps?: boolean, allowance?: bigint, fees?: (bigint | undefined)[], tokenFee?: string
} = {}) {
  const fetch = sameChainErc20Fetch()
  const sent: unknown[] = []
  let metadata = gasFee
  let allowance = settings.allowance ?? sameChainErc20Options.fromTokenAmount
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    getAllowance: async () => allowance,
    getTransactionReceipt: async hash => {
      const transaction = sent.at(-1) as { data: `0x${string}` }
      allowance = decodeFunctionData({ abi: erc20Abi, data: transaction.data }).args![1] as bigint
      return { status: 'success', transactionHash: hash }
    },
    sendTransaction: async tx => {
      sent.push(tx)
      const fee = (settings.fees ?? [123n])[sent.length - 1]
      return { hash: dummyHash(sent.length), ...(fee == null ? {} : { fee }) }
    }
  }, {
    sourceChainId: 56, entrance: 'wdk', tokenDecimals: ERC20_TOKEN_DECIMALS,
    ...(settings.caps ? { maxNetworkFeeBps: 10000, maxProtocolFeeBps: 10000 } : {}),
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      const body = await response.json() as { data: ButterRoute[] }
      if (new URL(url).pathname === '/route') {
        if (metadata === undefined) delete body.data[0]!.gasFee
        else body.data[0]!.gasFee = metadata as NonNullable<ButterRoute['gasFee']>
        if (settings.tokenFee != null) body.data[0]!.swapFee!.tokenFee = settings.tokenFee
      }
      return { ...response, json: async () => body }
    }
  })
  return { protocol, fetch, sent, setGasFee: (value: unknown) => { metadata = value } }
}

function networkFee (amount: bigint, reported = false, token = NATIVE_TOKEN, chain = '56') {
  return {
    type: 'network', amount, token, chain, included: false,
    description: reported ? 'Sender-reported source gas fee' : 'Estimated source chain gas fee'
  }
}

for (const [field, value] of [
  ['chainId', '137'], ['chainId', false], ['chainId', 56.5], ['chainId', {}],
  ['address', DEST_TOKEN], ['address', 'sol'], ['address', 'invalid'],
  ['address', 0], ['address', {}]
] as const) {
  for (const amount of ['0.0001', '0', undefined]) {
    it(`rejects gas ${field} ${JSON.stringify(value)} with amount ${amount} before swap or approval`, async () => {
      const test = executionHarness({ amount, [field]: value }, { allowance: 0n, caps: true })
      for (const method of ['quoteSwidge', 'swidge'] as const) {
        await assert.rejects(test.protocol[method](sameChainErc20Options), {
          name: 'ButterApiError',
          message: field === 'chainId'
            ? 'Butter gas fee chain does not match the source chain'
            : 'Butter gas fee token is not the source native token',
          details: { field: `gasFee.${field}`, sourceChainId: '56', value }
        })
      }

      assert.deepEqual(test.sent, [])
      assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
    })
  }
}

for (const metadata of [
  {}, { symbol: 'USDT' }, { address: NATIVE_TOKEN, chainId: 56 },
  { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chainId: ' 56 ' },
  { address: ' NaTiVe ' }, { address: null, chainId: null }, { address: ' ', chainId: '\t' }
]) {
  it(`reports source-native gas in quotes and execution with ${JSON.stringify(metadata)}`, async () => {
    const test = executionHarness({ amount: '0.0001', ...metadata })

    const quote = await test.protocol.quoteSwidge(sameChainErc20Options)
    const result = await test.protocol.swidge({ ...sameChainErc20Options, routeHash: quote.routeHash })

    assert.deepEqual(quote.fees, [networkFee(100000000000000n)])
    assert.deepEqual(result.fees, [networkFee(123n, true)])
    assert.equal(test.sent.length, 1)
    assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

it('retries a rejected fee identity instead of caching the invalid quote', async () => {
  const test = executionHarness({ amount: '0.0001', chainId: '137' })
  await assert.rejects(test.protocol.quoteSwidge(sameChainErc20Options), {
    name: 'ButterApiError', message: 'Butter gas fee chain does not match the source chain'
  })
  test.setGasFee({ amount: '0.0001' })

  const quote = await test.protocol.quoteSwidge(sameChainErc20Options)

  assert.deepEqual(quote.fees, [networkFee(100000000000000n)])
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route', '/route'])
})

it('rejects conflicting gas identities during execution without fee caps', async () => {
  const test = executionHarness({ amount: '0.0001', address: DEST_TOKEN }, { allowance: 0n })

  await assert.rejects(test.protocol.swidge(sameChainErc20Options), {
    name: 'ButterApiError', message: 'Butter gas fee token is not the source native token',
    details: { field: 'gasFee.address', sourceChainId: '56', value: DEST_TOKEN }
  })

  assert.deepEqual(test.sent, [])
  assert.deepEqual(test.fetch.calls.map(({ url }) => url.pathname), ['/route'])
})

for (const fees of [[10n, 20n, 30n], [10n, undefined, 30n]] as const) {
  it(`preserves fee aggregation when sends report ${String(fees)}`, async () => {
    const test = executionHarness({ amount: '0.0001' }, { allowance: 1n, fees: [...fees] })

    const result = await test.protocol.swidge(sameChainErc20Options)

    assert.deepEqual(result.fees, [fees[1] == null ? networkFee(100000000000000n) : networkFee(60n, true)])
    assert.deepEqual(result.transactions, [
      { hash: dummyHash(1), chain: '56', type: 'approval' },
      { hash: dummyHash(2), chain: '56', type: 'approval' },
      { hash: dummyHash(3), chain: '56', type: 'source' }
    ])
  })
}

it('appends a native network fee when the quote contains only a token protocol fee', async () => {
  const test = executionHarness(undefined, { tokenFee: '0.01' })

  const result = await test.protocol.swidge(sameChainErc20Options)

  assert.deepEqual(result.fees, [
    { type: 'protocol', amount: 10000000000000000n, token: ERC20_TOKEN, chain: '56', included: true, description: 'Butter token swap fee' },
    networkFee(123n, true)
  ])
})

it('replaces a no-fees placeholder with the sender-reported native fee', async () => {
  const test = executionHarness(undefined)
  const quote = await test.protocol.quoteSwidge(sameChainErc20Options)
  const result = await test.protocol.swidge(sameChainErc20Options)

  assert.deepEqual(quote.fees, [{ ...networkFee(0n), description: 'Butter reported no fees for this route' }])
  assert.deepEqual(result.fees, [networkFee(123n, true)])
})

const chains = [
  { chain: '56', token: NATIVE_TOKEN, decimals: 18, gas: 100000000000000n },
  { chain: '728126428', token: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', decimals: 6, gas: 100n },
  { chain: '1360108768460801', token: 'So11111111111111111111111111111111111111112', decimals: 9, gas: 100000n },
  { chain: '1360095883558913', token: 'native', decimals: 8, gas: 10000n },
  { chain: '123456', token: 'native', decimals: 18, gas: 100000000000000n },
  { chain: '123456', token: NATIVE_TOKEN, decimals: 18, gas: 100000000000000n, evm: ['123456'] },
  { chain: '123456', token: NATIVE_TOKEN, decimals: 6, gas: 100n, evm: ['123456'], override: true }
]

for (const asset of chains) {
  for (const placeholder of [false, true]) {
    it(`maps native fees on ${asset.chain} with token ${asset.token}, precision ${asset.decimals}, placeholder ${placeholder}`, async () => {
      const fetch = makeFetch({ '/route': () => ({ errno: 0, data: [quoteRoute({
        srcChain: { chainId: asset.chain, tokenIn: { address: ERC20_TOKEN, decimals: 18 }, totalAmountIn: '1.5' },
        dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '9.5' },
        bridgeFee: undefined,
        gasFee: placeholder ? undefined : { amount: '0.0001', address: asset.token, chainId: asset.chain },
        swapFee: placeholder ? undefined : { nativeFee: '0.0002', nativeSymbol: 'USDT', tokenFee: '0' }
      })] }), '/swap': () => ({ errno: 0, data: [{ to: 'adapter-router', value: '0', chainId: asset.chain }] }) })
      const protocol = new ButterSwidgeProtocol({
        getAddress: () => VALID_SENDER,
        sendTransaction: async () => ({ hash: dummyHash(1), fee: 123n })
      }, {
        sourceChainId: asset.chain, entrance: 'wdk', fetch, tokenDecimals: ERC20_TOKEN_DECIMALS,
        transactionAdapters: { [asset.chain]: tx => tx }, maxNativeFee: asset.gas * 2n,
        ...(asset.evm ? { evmChainIds: asset.evm } : {}),
        ...(asset.override ? { nativeTokenDecimals: { [asset.chain]: asset.decimals } } : {})
      })

      const quote = await protocol.quoteSwidge({ ...sameChainErc20Options, toChain: 137, recipient: VALID_RECIPIENT, slippage: 0.03 })

      assert.deepEqual(quote.fees, placeholder
        ? [{ ...networkFee(0n, false, asset.token, asset.chain), description: 'Butter reported no fees for this route' }]
        : [networkFee(asset.gas, false, asset.token, asset.chain), {
            type: 'protocol', amount: asset.gas * 2n, token: asset.token, chain: asset.chain,
            included: false, description: 'Butter native swap fee'
          }])
      if (asset.chain !== '56') {
        const result = await protocol.swidge({
          ...sameChainErc20Options, toChain: 137, recipient: VALID_RECIPIENT,
          slippage: 0.03, routeHash: quote.routeHash
        })

        assert.deepEqual(result.fees, [
          networkFee(123n, true, asset.token, asset.chain),
          ...(placeholder ? [] : [{
            type: 'protocol', amount: asset.gas * 2n, token: asset.token, chain: asset.chain,
            included: false, description: 'Butter native swap fee'
          }])
        ])
        assert.deepEqual(result.transactions, [{ hash: dummyHash(1), chain: asset.chain, type: 'source' }])
      }
    })
  }
}
