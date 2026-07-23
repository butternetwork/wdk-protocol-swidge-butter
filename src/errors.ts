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

/** Indicates malformed, inconsistent, or unsuccessful Butter API data. */
export class ButterApiError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterApiError'
    this.details = details
  }
}

/** Indicates an operation or option unsupported by this provider. */
export class ButterUnsupportedError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterUnsupportedError'
    this.details = details
  }
}

/** Indicates missing or invalid provider configuration. */
export class ButterConfigurationError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterConfigurationError'
    this.details = details
  }
}

/** Indicates that caller action is required before an operation can continue. */
export class ButterActionRequiredError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterActionRequiredError'
    this.details = details
  }
}

/**
 * Indicates that a configured fee cap could not be evaluated because the
 * Butter route lacks the metadata (USD values, gas fee) needed to value a fee
 * against the input amount. Fee limits fail closed on unvaluable routes.
 */
export class ButterFeeValuationError extends ButterApiError {
  constructor (message: string, details?: unknown) {
    super(message, details)
    this.name = 'ButterFeeValuationError'
  }
}

/** Indicates that a configured WDK network or protocol fee cap was exceeded. */
export class ButterFeeLimitExceededError extends ButterActionRequiredError {
  constructor (feeType: 'network' | 'protocol', actualBps: bigint, maximumBps: bigint) {
    super(`Butter ${feeType} fee exceeds the configured limit`, {
      feeType,
      actualBps: actualBps.toString(),
      maximumBps: maximumBps.toString()
    })
    this.name = 'ButterFeeLimitExceededError'
  }
}

/** Indicates that execution was attempted without a send-capable signer. */
export class ButterReadOnlyAccountError extends ButterConfigurationError {
  constructor (message = 'Swidge execution requires an account or signer that can send transactions') {
    super(message)
    this.name = 'ButterReadOnlyAccountError'
  }
}

/** Indicates use of exact-out, which Butter Router does not currently support. */
export class ButterExactOutUnsupportedError extends ButterUnsupportedError {
  constructor () {
    super('Butter router does not support exact-out swaps')
    this.name = 'ButterExactOutUnsupportedError'
  }
}

/** @deprecated Execution now obtains a route automatically when no quote is cached. */
export class ButterQuoteRequiredError extends ButterActionRequiredError {
  constructor () {
    super('A confirmed Butter quote is required before execution')
    this.name = 'ButterQuoteRequiredError'
  }
}

/** @deprecated Execution now refreshes expired cached quotes automatically. */
export class ButterQuoteExpiredError extends ButterActionRequiredError {
  constructor () {
    super('The confirmed Butter quote has expired; request a new quote')
    this.name = 'ButterQuoteExpiredError'
  }
}

/** Indicates that `/swap` transaction data does not match the requested intent. */
export class ButterTransactionValidationError extends ButterApiError {
  constructor (message: string, details?: unknown) {
    super(message, details)
    this.name = 'ButterTransactionValidationError'
  }
}
