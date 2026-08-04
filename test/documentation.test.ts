import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const repositoryRoot = process.cwd()

describe('WDK documentation requirements', () => {
  it('provides installation, configuration, a complete example, and discovery guidance', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## Install',
      '## Complete example',
      '## Configuration',
      '## Supported chains and tokens'
    ]) {
      assert.match(readme, new RegExp(`^${heading}$`, 'm'))
    }

    const example = section(readme, '## Complete example', '## Configuration')
    assert.match(example, /new ButterSwidgeProtocol\(/)
    assert.match(example, /getSupportedChains\(\)/)
    assert.match(example, /getSupportedTokens\(\{ fromChain: sourceChainId \}\)/)
    assert.match(example, /quoteSwidge\(options\)/)
    assert.doesNotMatch(example, /\baccount\b|viemWalletClient|viemPublicClient/)
  })

  it('documents every Butter status mapping and the same-chain receipt mapping', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')
    const mapping = section(readme, '## Status & fee mapping', '## Safety Defaults')

    for (const status of [
      'crossing',
      'pending',
      'success',
      'completed',
      'refund',
      'refunded',
      'action-required',
      'refund-pending',
      'failed',
      'cancelled',
      'expired',
      'partial'
    ]) {
      assert.match(mapping, new RegExp(`\\b${status}\\b`))
    }

    assert.match(mapping, /Same-chain receipt \| explicit success \| `completed`/)
    assert.match(mapping, /Same-chain receipt \| explicit revert \| `failed`/)
    assert.match(mapping, /Same-chain receipt \| missing \/ unknown \| `pending`/)
  })

  it('maps every fee source to itemized and legacy fields, including the placeholder', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')
    const mapping = section(readme, '## Status & fee mapping', '## Safety Defaults')

    for (const source of [
      'bridgeFee.in',
      'bridgeFee.out',
      'bridgeFee.affiliate',
      'bridgeFee.amount',
      'gasFee',
      'swapFee.nativeFee',
      'swapFee.tokenFee',
      'feeConfig',
      'No reported fees'
    ]) {
      assert.match(mapping, new RegExp(source.replaceAll('.', '\\.')))
    }

    assert.match(mapping, /No reported fees[^\n]*\| `network` \| `fee` \|/)
  })

  it('keeps unreleased changes ahead of the published SemVer release', async () => {
    const changelog = await readFile(join(repositoryRoot, 'CHANGELOG.md'), 'utf8')
    const unreleased = changelog.indexOf('## [Unreleased]')
    const release = changelog.indexOf('## [0.1.0] - 2026-08-04')

    assert.notEqual(unreleased, -1)
    assert.notEqual(release, -1)
    assert.ok(unreleased < release)
  })
})

function section (document: string, startHeading: string, endHeading: string): string {
  const start = document.indexOf(startHeading)
  const end = document.indexOf(endHeading, start + startHeading.length)
  assert.notEqual(start, -1, `Missing ${startHeading}`)
  assert.notEqual(end, -1, `Missing ${endHeading}`)
  return document.slice(start, end)
}
