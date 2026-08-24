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

  it('executes legacy swap without a previous quote', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: undefined,
            swapFee: undefined,
            srcChain: {
              chainId: '56',
              tokenIn: { address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '0',
            data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n),
            chainId: '56',
            method: 'swapAndCall'
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          publicClient: { readContract: async () => 1500000000000000000n },
          walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111')
        }
      })
  
      const result = await protocol.swap({
        tokenIn: ERC20_TOKEN,
        tokenOut: DEST_TOKEN,
        tokenInAmount: 1500000000000000000n,
        to: VALID_RECIPIENT
      })
  
      assert.deepEqual(result, {
        hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        fee: 0n,
        tokenInAmount: 1500000000000000000n,
        tokenOutAmount: 10250000n
      })
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('executes legacy bridge without a previous quote', async () => {
      const bitcoinChain = '1360095883558913'
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('slippage'), '300')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              bridgeFee: undefined,
              gasFee: undefined,
              swapFee: undefined,
              contract: undefined,
              srcChain: {
                chainId: bitcoinChain,
                tokenIn: { address: 'btc', decimals: 8, symbol: 'BTC' },
                totalAmountIn: '1',
                totalAmountOut: '1'
              },
              dstChain: {
                chainId: '137',
                tokenOut: { address: 'btc', decimals: 8, symbol: 'BTC' },
                totalAmountOut: '1'
              },
              minAmountOut: { amount: '0.99', symbol: 'BTC' }
            })]
          }
        },
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: 'btc-deposit', value: '0', chainId: bitcoinChain }]
        })
      })
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        sendTransaction: async () => 'btc-hash'
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch,
        transactionAdapters: {
          [bitcoinChain]: (tx) => tx
        }
      })
  
      const result = await protocol.bridge({
        // WDK declares `targetChain` as a string; `normalizeId` accepts either form,
        // so this only pins the declared type.
        token: 'btc',
        amount: 100000000n,
        targetChain: '137',
        recipient: 'btc-recipient'
      })
  
      assert.equal(result.hash, 'btc-hash')
    })

  it('quotes a legacy swap without an account', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        })
      })
      // quoteSwidge tolerates an absent account, so the legacy quote path must too:
      // the base class only requires an account for the executing methods.
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwap({
        tokenIn: '0x00000000000000000000000000000000000000ab',
        tokenOut: '0x00000000000000000000000000000000000000cd',
        tokenInAmount: 1500000000000000000n,
        to: VALID_RECIPIENT
      })
  
      assert.equal(quote.tokenInAmount, 1500000000000000000n)
      assert.equal(quote.tokenOutAmount, 10250000n)
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('quotes a legacy bridge with fees grouped by type', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            // A bridge sends the same token to the destination chain, so the route's
            // output token has to match the input for validateRouteMatchesRequest.
            dstChain: {
              chainId: '137',
              tokenOut: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
              totalAmountOut: '1.4'
            },
            minAmountOut: { amount: '1.39', symbol: 'BNB' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteBridge({
        token: '0x00000000000000000000000000000000000000ab',
        amount: 1500000000000000000n,
        targetChain: '137',
        recipient: VALID_RECIPIENT
      })
  
      // Unlike swap()/quoteSwap(), the base class groups these by fee type: legacy
      // `fee` takes only `network`, legacy `bridgeFee` only `protocol`.
      assert.equal(quote.fee, 100000000000000n) // gasFee 0.0001 BNB
      // Still a cross-denomination sum inside one group: 0.25 USDT + 0.02 BNB.
      assert.equal(quote.bridgeFee, 250000n + 20000000000000000n)
    })
})
