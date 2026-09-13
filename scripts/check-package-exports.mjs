// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import ButterSwidgeProtocolDefault, * as ButterPackage from '@butternetwork/wdk-protocol-swidge-butter'
import {
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
  ButterSwidgeProtocol,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  MaximumFeeExceededError,
  ProviderError,
  ProviderRequiredError,
  TransactionError,
  UnsupportedOperationError,
  ValueError,
  WdkError
} from '@butternetwork/wdk-protocol-swidge-butter'
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

if (ButterSwidgeProtocolDefault !== ButterSwidgeProtocol) {
  throw new Error('Package default export does not match ButterSwidgeProtocol')
}

if (ButterApiError.name !== 'ButterApiError') {
  throw new Error('Package did not expose ButterApiError')
}

if ('toEvmWalletClient' in ButterPackage) {
  throw new Error('Package still exposes the removed toEvmWalletClient API')
}

if (
  WdkError !== UpstreamWdkError ||
  ValueError !== WdkValueError ||
  UnsupportedOperationError !== WdkUnsupportedOperationError ||
  MaximumFeeExceededError !== WdkMaximumFeeExceededError ||
  ProviderError !== WdkProviderError ||
  ProviderRequiredError !== WdkProviderRequiredError ||
  TransactionError !== WdkTransactionError ||
  AccountRequiredError !== WdkAccountRequiredError
) {
  throw new Error('Package did not re-export the upstream WDK error constructors')
}

const cause = new Error('root cause')
const apiDetails = { endpoint: '/route', cause }
const configurationDetails = { option: 'entrance', cause }
const unsupportedDetails = { operation: 'exactOut', cause }
const actionDetails = { action: 'requote', cause }
const valuationDetails = { component: 'bridgeFee.in', cause }
const noRouteDetails = { from: '56', to: '137', cause }
const validationDetails = { field: 'initiator', cause }
const partialTransactions = [{
  hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  chain: '56',
  type: 'approval'
}]
const errorCases = [
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

for (const { error, parents, name, message, details, cause: expectedCause } of errorCases) {
  if (
    !parents.every((Parent) => error instanceof Parent) ||
    error.name !== name ||
    error.message !== message ||
    !sameValue(error.details, details) ||
    error.cause !== expectedCause
  ) {
    throw new Error(`Package exposed an invalid ${name} prototype or diagnostic`)
  }
}

function sameValue (actual, expected) {
  if (Object.is(actual, expected)) return true
  if (actual == null || expected == null || typeof actual !== 'object' || typeof expected !== 'object') return false

  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(actual, key) && sameValue(actual[key], expected[key]))
}
