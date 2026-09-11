import assert from 'node:assert/strict'
import { it } from 'node:test'
import ButterSwidgeProtocol from '../../src/index.ts'
import { makeFetch, NATIVE_TOKEN } from '../helpers/protocol-fixtures.ts'

const validChain = { chainId: '56', name: 'BSC', chainType: 'EVM', nativeToken: { symbol: 'BNB' } }
const expectedChain = { id: '56', name: 'BSC', type: 'evm', nativeToken: 'BNB', execution: 'native' }
const candidateChain = { chainId: '137', name: 'Polygon', chainType: 'EVM', nativeToken: { symbol: 'POL' } }

function discovery (chains: unknown[], details: unknown[] = []) {
  const fetch = makeFetch({
    '/supportedChainInfo': () => ({ errno: 0, data: chains }),
    '/api/queryChainList': () => ({ code: 200, data: { chains: details } })
  })
  return {
    protocol: new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch }),
    fetch
  }
}

for (const invalidId of [{ bad: true }, ['137'], true, '', '  ']) {
  it(`drops a chain with invalid id ${JSON.stringify(invalidId)} without discarding its sibling`, async () => {
    const { protocol, fetch } = discovery([validChain, { ...candidateChain, chainId: invalidId }])

    const chains = await protocol.getSupportedChains()

    assert.deepEqual(chains, [expectedChain])
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedChainInfo', '/api/queryChainList'])
  })
}

const invalidFields = [
  { chainType: { bad: true } },
  { chainType: ['EVM'] },
  { chainType: false },
  { chainType: '  ' },
  { name: { bad: true } },
  { name: ['Polygon'] },
  { nativeToken: { symbol: { bad: true } } },
  { nativeToken: { symbol: ['POL'] } },
  { nativeToken: { symbol: '  ' } },
  { nativeToken: '{"symbol":123}' },
  { nativeToken: '[{"symbol":"POL"}]' }
]

for (const fields of invalidFields) {
  for (const source of ['router', 'details']) {
    it(`drops invalid chain fields ${JSON.stringify(fields)} from ${source}`, async () => {
      const { protocol } = source === 'router'
        ? discovery([validChain, { ...candidateChain, ...fields }])
        : discovery([validChain, candidateChain], [{ chainId: '137', ...fields }])

      const chains = await protocol.getSupportedChains()

      assert.deepEqual(chains, [expectedChain])
    })
  }
}

it('normalizes scalar chain metadata and uses the id when the name is absent', async () => {
  const { protocol } = discovery([
    { id: 56, type: ' EVM ', nativeToken: '{"symbol":" BNB "}' },
    { chainId: ' 137 ', chainType: 'EVM', name: '   ', nativeToken: { symbol: 'POL' } }
  ], [
    { chainId: {}, name: { bad: true } },
    { chainId: ' 56 ', key: 'bsc' }
  ])

  const chains = await protocol.getSupportedChains()

  assert.deepEqual(chains, [
    { id: '56', name: '56', type: 'evm', nativeToken: 'BNB', execution: 'native' },
    { id: '137', name: '137', type: 'evm', nativeToken: 'POL', execution: 'native' }
  ])
})

it('retains the strict slippage floor of a chain dropped for malformed native metadata', async () => {
  const { protocol, fetch } = discovery([
    validChain,
    { chainId: '98765', name: 'Bitcoin additional network', chainType: { toString: {} }, nativeToken: { symbol: {} } }
  ])

  const chains = await protocol.getSupportedChains()
  await assert.rejects(protocol.quoteSwidge({
    fromToken: NATIVE_TOKEN, toToken: 'btc', toChain: '98765',
    fromTokenAmount: 1000000000000000000n, slippage: 0.01
  }), {
    name: 'ButterActionRequiredError',
    message: 'Butter requires at least 300 bps slippage for this route',
    details: { requestedBps: 100, requiredBps: 300 }
  })

  assert.deepEqual(chains, [expectedChain])
  assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/supportedChainInfo', '/api/queryChainList'])
})
