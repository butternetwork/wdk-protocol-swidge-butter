import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse } from 'yaml'

interface PackageManifest {
  name?: string
  version?: string
  repository?: { type?: string, url?: string }
  bugs?: { url?: string }
  homepage?: string
  publishConfig?: { access?: string, registry?: string }
  files?: string[]
}

interface WorkflowStep {
  name?: string
  id?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface PublishWorkflow {
  on?: { release?: { types?: string[] } }
  permissions?: Record<string, string>
  jobs?: {
    publish?: {
      'runs-on'?: string
      'timeout-minutes'?: number
      steps?: WorkflowStep[]
    }
  }
}

const repositoryRoot = process.cwd()

describe('npm release configuration', () => {
  it('publishes the package from the canonical public repository and registry', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.equal(packageJson.name, '@butternetwork/wdk-protocol-swidge-butter')
    assert.deepEqual(packageJson.repository, {
      type: 'git',
      url: 'git+https://github.com/butternetwork/wdk-protocol-swidge-butter.git'
    })
    assert.deepEqual(packageJson.bugs, {
      url: 'https://github.com/butternetwork/wdk-protocol-swidge-butter/issues'
    })
    assert.equal(
      packageJson.homepage,
      'https://github.com/butternetwork/wdk-protocol-swidge-butter#readme'
    )
    assert.deepEqual(packageJson.publishConfig, {
      access: 'public',
      registry: 'https://registry.npmjs.org'
    })
  })

  it('publishes the security policy with the npm package', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.equal(packageJson.files?.includes('SECURITY.md'), true)
  })

  it('publishes GitHub Releases through OIDC without a long-lived npm token', async () => {
    const { document, source } = await readPublishWorkflow()
    const publish = document.jobs?.publish
    const steps = publish?.steps ?? []

    assert.deepEqual(document.on, { release: { types: ['published'] } })
    assert.deepEqual(document.permissions, { contents: 'read', 'id-token': 'write' })
    assert.equal(publish?.['runs-on'], 'ubuntu-latest')
    assert.equal(publish?.['timeout-minutes'], 10)
    assert.deepEqual(steps[0], {
      uses: 'actions/checkout@v6',
      with: { ref: '${{ github.event.release.tag_name }}' }
    })
    assert.deepEqual(steps[1], {
      uses: 'actions/setup-node@v6',
      with: {
        'node-version': 24,
        'registry-url': 'https://registry.npmjs.org',
        'package-manager-cache': false
      }
    })
    assert.deepEqual(steps.slice(2, 8).map(({ name, run }) => ({ name, run })), [
      { name: 'Use an OIDC-capable npm version', run: 'npm install --global npm@11' },
      { name: undefined, run: 'npm ci' },
      { name: undefined, run: 'npm test' },
      { name: undefined, run: 'npm run typecheck' },
      { name: undefined, run: 'npm run build' },
      { name: undefined, run: 'npm pack --dry-run' }
    ])
    assert.deepEqual(steps[8], {
      name: 'Verify release tag',
      env: { RELEASE_TAG: '${{ github.event.release.tag_name }}' },
      run: 'node scripts/check-release-tag.mjs "$RELEASE_TAG"'
    })
    assert.deepEqual(steps.at(-1), {
      name: 'Publish package',
      if: "steps.npm_state.outputs.publish == 'true'",
      env: { NPM_TAG: "${{ github.event.release.prerelease && 'next' || 'latest' }}" },
      run: 'npm publish --tag "$NPM_TAG"'
    })
    assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./)
  })

  it('skips an identical published version and fails closed on registry ambiguity', async () => {
    const { document } = await readPublishWorkflow()
    const steps = document.jobs?.publish?.steps ?? []
    const registryCheck = steps.findIndex(({ name }) => name === 'Check npm publication state')
    const publishStep = steps.findIndex(({ name }) => name === 'Publish package')
    const registryScript = steps[registryCheck]?.run ?? ''

    assert.equal(registryCheck, 9)
    assert.equal(publishStep, 10)
    assert.equal(steps[registryCheck]?.id, 'npm_state')
    assert.equal(steps[publishStep]?.if, "steps.npm_state.outputs.publish == 'true'")
    assert.match(registryScript, /\['rev-parse', 'HEAD'\]/)
    assert.match(registryScript, /\['view', `\$\{name\}@\$\{version\}`, 'gitHead', '--json'\]/)
    assert.match(registryScript, /\\bE404\\b/)
    assert.match(registryScript, /GITHUB_OUTPUT/)
    assert.match(registryScript, /already exists at/)
    assert.match(registryScript, /npm view failed/)
  })

  it('accepts only a release tag matching the package version', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest
    const expectedTag = `v${packageJson.version}`

    const accepted = spawnSync(process.execPath, [
      'scripts/check-release-tag.mjs',
      expectedTag
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.equal(
      accepted.stdout.trim(),
      `Release tag ${expectedTag} matches package version ${packageJson.version}`
    )

    const rejected = spawnSync(process.execPath, [
      'scripts/check-release-tag.mjs',
      `${expectedTag}-wrong`
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    const errorLine = rejected.stderr.split('\n').find((line) => line.startsWith('Error: '))
    assert.equal(
      errorLine,
      `Error: Release tag ${expectedTag}-wrong does not match package version ${expectedTag}`
    )
  })
})

async function readPublishWorkflow (): Promise<{ document: PublishWorkflow, source: string }> {
  const source = await readFile(join(repositoryRoot, '.github/workflows/publish.yml'), 'utf8')
  return { document: parse(source) as PublishWorkflow, source }
}
