export class ButterApiError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterApiError'
    this.details = details
  }
}

export class ButterUnsupportedError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterUnsupportedError'
    this.details = details
  }
}

export class ButterConfigurationError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterConfigurationError'
    this.details = details
  }
}

export class ButterActionRequiredError extends Error {
  readonly details: unknown

  constructor (message: string, details?: unknown) {
    super(message)
    this.name = 'ButterActionRequiredError'
    this.details = details
  }
}

export class ButterExactOutUnsupportedError extends ButterUnsupportedError {
  constructor () {
    super('Butter router does not support exact-out swaps')
    this.name = 'ButterExactOutUnsupportedError'
  }
}

export class ButterQuoteRequiredError extends ButterActionRequiredError {
  constructor () {
    super('A confirmed Butter quote is required before execution')
    this.name = 'ButterQuoteRequiredError'
  }
}

export class ButterQuoteExpiredError extends ButterActionRequiredError {
  constructor () {
    super('The confirmed Butter quote has expired; request a new quote')
    this.name = 'ButterQuoteExpiredError'
  }
}

export class ButterTransactionValidationError extends ButterApiError {
  constructor (message: string, details?: unknown) {
    super(message, details)
    this.name = 'ButterTransactionValidationError'
  }
}
