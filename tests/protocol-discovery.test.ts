import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroHash
} from 'viem'
import ButterSwidgeProtocol, {
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterFeeLimitExceededError,
  ButterNoRouteError,
  ButterPartialExecutionError,
  ButterReadOnlyAccountError,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  parseTokenAmount,
  toButterSlippage,
  toEvmWalletClient,
  toEvmPublicClient
} from '../src/index.ts'
import {
  jsonResponse,
  failAfter,
  assertError,
  makeFetch,
  quoteRoute,
  NATIVE_TOKEN,
  ERC20_TOKEN,
  DEST_TOKEN,
  VALID_SENDER,
  VALID_RECIPIENT,
  ROUTER,
  SOLANA_CHAIN_ID,
  FORMER_TON_CHAIN_ID,
  DEFAULT_TOKEN_DECIMALS,
  ERC20_TOKEN_DECIMALS,
  evmWallet,
  routerV3Abi,
  swapParamAbi,
  bridgeParamAbi,
  bridgeAdapterParamAbi,
  remoteSwapAndCallAbi,
  crossChainSwapData,
  feeParamAbi,
  encodeFeeData,
  sourceChainWithToken,
  sameChainSwapDataFor,
  NATIVE_FEE_PART,
  nativeFeeFetch,
  nativeFeeOptions,
  multiTxAdapterFetch,
  threeTxAdapterFetch,
  threeTxAdapter,
  oversizedAllowanceFetch,
  protocolFailingOnSend,
  sameChainErc20Options,
  sameChainErc20Fetch,
  erc20FeeProtocol
} from './helpers/protocol-fixtures.js'

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  let account: { getAddress: () => Promise<string>, sendTransaction: (tx: unknown) => Promise<{ hash: string, tx: unknown }> }

  beforeEach(() => {
    account = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction (tx) { return { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', tx } }
    }
  })

  it('reports generic adapter capability for the former TON chain id', async () => {
      const fetch = makeFetch({
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            id: FORMER_TON_CHAIN_ID,
            type: 'TON',
            name: 'TON',
            nativeToken: '{"symbol":"TON","decimals":9}'
          }]
        }),
        '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: FORMER_TON_CHAIN_ID,
        entrance: 'wdk',
        fetch,
        transactionAdapters: {
          [FORMER_TON_CHAIN_ID]: (swapTx) => swapTx
        }
      })
  
      const chains = await protocol.getSupportedChains()
  
      assert.deepEqual(chains, [{
        id: FORMER_TON_CHAIN_ID,
        name: 'TON',
        type: 'ton',
        nativeToken: 'TON',
        execution: 'adapter'
      }])
    })

  it('returns the Router advertised token catalog without priming chain metadata', async () => {
      const fetch = makeFetch({
        '/supportedTokenList': async (url) => {
          assert.equal(url.searchParams.get('chainId'), '56')
          return {
            errno: 0,
            message: 'success',
            data: [{
              chainId: 56,
              tokens: [{
                chainId: 56,
                address: '0x00000000000000000000000000000000000000aa',
                decimals: 18,
                symbol: 'TOKEN',
                name: 'Token'
              }]
            }]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch
      })
  
      const tokens = await protocol.getSupportedTokens({ fromChain: 56 })
  
      assert.deepEqual(tokens, [{
        token: '0x00000000000000000000000000000000000000aa',
        chain: '56',
        symbol: 'TOKEN',
        decimals: 18,
        address: '0x00000000000000000000000000000000000000aa',
        name: 'Token'
      }])
    })

  it('drops a chain missing its type from getSupportedChains', async () => {
      const fetch = makeFetch({
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [
            { id: '56', type: 'EVM', name: 'BNB Chain', nativeToken: '{"symbol":"BNB","decimals":18}' },
            { id: '137', name: 'Polygon', nativeToken: '{"symbol":"POL","decimals":18}' }
          ]
        }),
        '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const chains = await protocol.getSupportedChains()
  
      // WDK marks `type` as required, so the chain is dropped rather than listed
      // with a placeholder that reads like a real chain type.
      assert.deepEqual(chains.map((chain) => chain.id), ['56'])
    })

  it('drops a chain missing its native token symbol from getSupportedChains', async () => {
      const fetch = makeFetch({
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [
            { id: '56', type: 'EVM', name: 'BNB Chain', nativeToken: '{"symbol":"BNB","decimals":18}' },
            { id: '137', type: 'EVM', name: 'Polygon' },
            { id: '8453', type: 'EVM', name: 'Base', nativeToken: '{"decimals":18}' }
          ]
        }),
        '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const chains = await protocol.getSupportedChains()
  
      // Both an absent blob and one that parses without a symbol are dropped.
      assert.deepEqual(chains.map((chain) => chain.id), ['56'])
    })

  it('drops malformed chain rows without discarding valid rows', async () => {
      const fetch = makeFetch({
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [null, 7, { id: '56', type: 'EVM', name: 'BNB Chain', nativeToken: '{"symbol":"BNB"}' }]
        }),
        '/api/queryChainList': async () => ({
          code: 200,
          message: 'success',
          data: { chains: [null, 'invalid', { chainId: '56', key: 'bsc' }] }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const chains = await protocol.getSupportedChains()
  
      assert.deepEqual(chains.map(({ id }) => id), ['56'])
    })

  it('returns an empty list for a supported chain with no tokens', async () => {
      const fetch = makeFetch({
        '/supportedTokenList': async () => ({
          errno: 0,
          message: 'success',
          data: [{ chainId: 56, tokens: [] }]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      assert.deepEqual(await protocol.getSupportedTokens({ fromChain: 56 }), [])
    })

  it('requires exactly one supported-token group for the requested chain', async () => {
      const invalidGroups: unknown[] = [
        [],
        [{ chainId: 137, tokens: [] }],
        [null, { chainId: 56, tokens: [] }],
        [{ chainId: 56, tokens: [] }, { chainId: 56, tokens: [] }]
      ]
  
      for (const data of invalidGroups) {
        const fetch = makeFetch({
          '/supportedTokenList': async () => ({ errno: 0, message: 'success', data })
        })
        const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
        await assert.rejects(
          protocol.getSupportedTokens({ fromChain: 56 }),
          { name: 'ButterApiError', message: 'Butter Router supported-token list must return exactly one group for the requested chain' }
        )
      }
    })

  it('requires the supported-token group to contain a token array', async () => {
      for (const tokens of [undefined, null, { address: '0x00000000000000000000000000000000000000aa' }]) {
        const fetch = makeFetch({
          '/supportedTokenList': async () => ({
            errno: 0,
            message: 'success',
            data: [{ chainId: 56, ...(tokens !== undefined ? { tokens } : {}) }]
          })
        })
        const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
        await assert.rejects(
          protocol.getSupportedTokens({ fromChain: 56 }),
          { name: 'ButterApiError', message: 'Butter Router supported-token group must contain a token array' }
        )
      }
    })

  it('drops malformed and wrong-chain tokens while preserving format-aware deduplication', async () => {
      const upper = 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK'
      const lower = 'abcdefghjklmnpqrstuvwxyz123456789abcdefghjk'
      const fetch = makeFetch({
        '/supportedTokenList': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            chainId: 56,
            tokens: [
              null,
              7,
              { chainId: 56, address: '0x0000000000000000000000000000000000000AaA', decimals: 18, symbol: 'AAA' },
              { chainId: '56', address: '0x0000000000000000000000000000000000000aaa', decimals: 18, symbol: 'AAA duplicate' },
              { chainId: 137, address: '0x00000000000000000000000000000000000000fe', decimals: 18, symbol: 'WRONG' },
              { chainId: 56, address: '0x00000000000000000000000000000000000000ba', symbol: 'BAD' },
              { address: upper, decimals: 6, symbol: 'UPPER' },
              { address: lower, decimals: 9, symbol: 'LOWER' }
            ]
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const tokens = await protocol.getSupportedTokens({ fromChain: 56 })
  
      assert.deepEqual(tokens.map((token) => token.token), ['0x0000000000000000000000000000000000000AaA', upper, lower])
      assert.deepEqual(tokens.map((token) => token.chain), ['56', '56', '56'])
      assert.deepEqual(tokens.map((token) => token.decimals), [18, 6, 9])
    })

  it('rejects a non-array Router supported-token payload', async () => {
      const fetch = makeFetch({
        '/supportedTokenList': async () => ({
          errno: 0,
          message: 'success',
          data: { chainId: 56, tokens: [] }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.getSupportedTokens({ fromChain: 56 }),
        { name: 'ButterApiError', message: 'Butter Router supported-token list returned a non-array payload' }
      )
    })

  for (const [name, routerPayload, tokenPayload, message] of [
      ['router chain collection', {}, { chains: [] }, 'Butter supported-chain list returned a non-array payload'],
      ['token chain envelope', [], null, 'Butter token-chain envelope returned an invalid payload'],
      ['token chain collection', [], { chains: {} }, 'Butter token-chain list returned a non-array payload']
    ] as const) {
      it(`rejects a malformed ${name} with a Butter API error`, async () => {
        const fetch = makeFetch({
          '/supportedChainInfo': async () => ({ errno: 0, message: 'success', data: routerPayload }),
          '/api/queryChainList': async () => ({ code: 200, message: 'success', data: tokenPayload })
        })
        const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
        await assert.rejects(protocol.getSupportedChains(), { name: 'ButterApiError', message })
      })
    }
})
