import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import {
  MaximumFeeExceededError as WdkMaximumFeeExceededError,
  ProviderError as WdkProviderError,
  ProviderRequiredError as WdkProviderRequiredError,
  TransactionError as WdkTransactionError,
  UnsupportedOperationError as WdkUnsupportedOperationError,
  ValueError as WdkValueError,
  WdkError as UpstreamWdkError
} from '@tetherto/wdk-wallet'
import { AccountRequiredError as WdkAccountRequiredError } from '@tetherto/wdk-wallet/protocols'
import ButterSwidgeProtocol, {
  AccountRequiredError,
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterFeeLimitExceededError,
  ButterFeeValuationError,
  ButterNoRouteError,
  ButterPartialExecutionError,
  ButterReadOnlyAccountError,
  ButterUnsupportedError,
  ButterTransactionValidationError,
  MaximumFeeExceededError,
  ProviderError,
  ProviderRequiredError,
  TransactionError,
  UnsupportedOperationError,
  ValueError,
  WdkError,
  type ButterSwidgeProtocolConfig
} from '../src/index.ts'
// @ts-expect-error Version 0.2 removes the wallet-client compatibility type.
import type { EvmWalletClient } from '../src/index.ts'
// @ts-expect-error Version 0.2 removes the viem wallet-client compatibility type.
import type { ViemWalletClientLike } from '../src/index.ts'

type ProtocolAccount = ConstructorParameters<typeof ButterSwidgeProtocol>[0]
const acceptsWdkEvmAccount: WalletAccountEvm extends NonNullable<ProtocolAccount> ? true : false = true
type AccountTransaction = Parameters<NonNullable<NonNullable<ProtocolAccount>['sendTransaction']>>[0]
const acceptsHostTransaction: { payload: string } extends AccountTransaction ? true : false = true
const configWithoutLegacyWalletClient: ButterSwidgeProtocolConfig = {
  sourceChainId: 56,
  entrance: 'wdk',
  evm: {
    // @ts-expect-error Version 0.2 accepts only the read-only EVM client here.
    walletClient: {}
  }
}

describe('WDK public contracts', () => {
  it('accepts the published WDK EVM account type', () => {
    assert.equal(acceptsWdkEvmAccount, true)
    assert.equal(acceptsHostTransaction, true)
    assert.equal(configWithoutLegacyWalletClient.sourceChainId, 56)
  })

  it('re-exports the upstream WDK error constructors unchanged', () => {
    assert.equal(WdkError, UpstreamWdkError)
    assert.equal(ValueError, WdkValueError)
    assert.equal(UnsupportedOperationError, WdkUnsupportedOperationError)
    assert.equal(MaximumFeeExceededError, WdkMaximumFeeExceededError)
    assert.equal(ProviderError, WdkProviderError)
    assert.equal(ProviderRequiredError, WdkProviderRequiredError)
    assert.equal(TransactionError, WdkTransactionError)
    assert.equal(AccountRequiredError, WdkAccountRequiredError)
  })

  it('makes Butter errors catchable through their WDK categories', async () => {
    const cause = new Error('root cause')
    const apiDetails = { endpoint: '/route', cause }
    const configurationDetails = { option: 'entrance', cause }
    const unsupportedDetails = { operation: 'exactOut', cause }
    const actionDetails = { action: 'requote', cause }
    const valuationDetails = { component: 'bridgeFee.in', cause }
    const noRouteDetails = { from: '56', to: '137', cause }
    const validationDetails = { field: 'initiator', cause }
    const partialTransactions = [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' as const }]
    const cases = [
      { error: new ButterApiError('api', apiDetails), parents: [WdkError], name: 'ButterApiError', message: 'api', details: apiDetails, cause },
      { error: new ButterConfigurationError('config', configurationDetails), parents: [ValueError], name: 'ButterConfigurationError', message: 'config', details: configurationDetails, cause },
      { error: new ButterUnsupportedError('unsupported', unsupportedDetails), parents: [UnsupportedOperationError], name: 'ButterUnsupportedError', message: 'unsupported', details: unsupportedDetails, cause },
      { error: new ButterActionRequiredError('action', actionDetails), parents: [WdkError], name: 'ButterActionRequiredError', message: 'action', details: actionDetails, cause },
      { error: new ButterFeeValuationError('unvaluable fee', valuationDetails), parents: [ButterApiError, WdkError], name: 'ButterFeeValuationError', message: 'unvaluable fee', details: valuationDetails, cause },
      { error: new ButterNoRouteError('no route', noRouteDetails), parents: [ButterApiError, WdkError], name: 'ButterNoRouteError', message: 'no route', details: noRouteDetails, cause },
      { error: new ButterExactOutUnsupportedError(), parents: [ButterUnsupportedError, UnsupportedOperationError], name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps', details: undefined, cause: undefined },
      { error: new ButterFeeLimitExceededError('network', 2n, 1n), parents: [MaximumFeeExceededError], name: 'ButterFeeLimitExceededError', message: 'Butter network fee exceeds the configured limit', details: { feeType: 'network', actualBps: '2', maximumBps: '1' }, cause: undefined },
      { error: new ButterReadOnlyAccountError(), parents: [AccountRequiredError], name: 'ButterReadOnlyAccountError', message: 'Swidge execution requires an account or signer that can send transactions', details: undefined, cause: undefined },
      { error: new ButterTransactionValidationError('invalid transaction', validationDetails), parents: [ButterApiError, WdkError], name: 'ButterTransactionValidationError', message: 'invalid transaction', details: validationDetails, cause },
      { error: new ButterPartialExecutionError(partialTransactions, cause, 'source'), parents: [ButterActionRequiredError, WdkError], name: 'ButterPartialExecutionError', message: 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them', details: { transactions: partialTransactions, failedType: 'source', cause }, cause }
    ]

    for (const item of cases) {
      await assert.rejects(Promise.reject(item.error), (error: unknown) => {
        if (!(error instanceof Error)) return false
        if (!item.parents.every((Parent) => error instanceof Parent)) return false
        assert.deepEqual(
          { name: error.name, message: error.message, details: (error as { details?: unknown }).details, cause: (error as { cause?: unknown }).cause },
          { name: item.name, message: item.message, details: item.details, cause: item.cause }
        )
        return true
      })
    }
  })
})
