import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as ts from 'typescript'

const repositoryRoot = process.cwd()

describe('WDK documentation requirements', () => {
  it('uses the reviewed Built with WDK badge', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')
    const badge = await readFile(join(repositoryRoot, 'docs/assets/built-with-wdk.png'))

    assert.equal(readme.includes('src="./docs/assets/built-with-wdk.png"'), true)
    assert.equal(readme.includes('href="https://docs.wdk.tether.io/"'), true)
    assert.equal(readme.includes('alt="Built with WDK"'), true)
    assert.equal(
      createHash('sha256').update(badge).digest('hex'),
      '6a9ba1dc25883ac4586e63ecf723cab9d194dd2e3b592e936ae9c37c6044dd5e'
    )
    assert.equal(badge.readUInt32BE(16), 240)
    assert.equal(badge.readUInt32BE(20), 60)
  })

  it('documents every named source declaration using WDK JSDoc rules', async () => {
    const sourceDirectory = join(repositoryRoot, 'src')
    const sourceFiles = (await readdir(sourceDirectory))
      .filter((file) => file.endsWith('.ts'))
      .sort()
    const violations: string[] = []

    for (const file of sourceFiles) {
      const source = await readFile(join(sourceDirectory, file), 'utf8')
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      )
      if (/\bArray</.test(source)) {
        violations.push(`${file}: use T[] instead of Array<T>`)
      }
      collectJSDocViolations(sourceFile, violations)
      collectPublicComponentViolations(sourceFile, violations)
    }

    assert.deepEqual(violations, [])
  })

  it('keeps package behavior tests on the root public API', async () => {
    const testDirectory = join(repositoryRoot, 'tests')
    const testFiles = (await readdir(testDirectory))
      .filter((file) => file.endsWith('.ts'))
      .sort()
    const violations: string[] = []

    for (const file of testFiles) {
      const source = await readFile(join(testDirectory, file), 'utf8')
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      if (/\bassert\.(?:ok|match|doesNotMatch|doesNotThrow)\s*\(/.test(source)) {
        violations.push(`${file}: uses a broad assertion instead of an exact value`)
      }
      if (/\(error:\s*unknown\)\s*=>[^\n]*(?:\.test\(error\.message\)|error\.message\.includes)/.test(source)) {
        violations.push(`${file}: uses a pattern or substring instead of an exact error message`)
      }
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const imported = statement.moduleSpecifier.text
        if (imported.startsWith('../src/') && imported !== '../src/index.ts') {
          violations.push(`${file}: imports internal module ${imported}`)
        }
      }
    }

    assert.deepEqual(violations, [])
  })

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

type DocumentedDeclaration =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

function collectJSDocViolations (sourceFile: ts.SourceFile, violations: string[]): void {
  function visit (node: ts.Node): void {
    if (isDocumentedDeclaration(node)) validateJSDoc(sourceFile, node, violations)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

function collectPublicComponentViolations (sourceFile: ts.SourceFile, violations: string[]): void {
  for (const declaration of sourceFile.statements) {
    if (sourceFile.fileName === 'types.ts' && ts.isInterfaceDeclaration(declaration)) {
      if (!hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) continue
      for (const member of declaration.members) {
        if (ts.getJSDocCommentsAndTags(member).some((item) => item.kind === ts.SyntaxKind.JSDocComment)) continue
        const line = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
        violations.push(`${sourceFile.fileName}:${line} ${declaration.name.text}: public interface member needs a description`)
      }
    }

    if (ts.isClassDeclaration(declaration) && hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) {
      for (const member of declaration.members) {
        if (!ts.isPropertyDeclaration(member) || hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue
        if (ts.getJSDocCommentsAndTags(member).some((item) => item.kind === ts.SyntaxKind.JSDocComment)) continue
        const line = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
        violations.push(`${sourceFile.fileName}:${line} ${declaration.name?.text ?? '<anonymous>'}: public property needs a description`)
      }
    }
  }
}

function hasModifier (node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true
}

function isDocumentedDeclaration (node: ts.Node): node is DocumentedDeclaration {
  return (
    (ts.isFunctionDeclaration(node) && node.name != null) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function validateJSDoc (
  sourceFile: ts.SourceFile,
  declaration: DocumentedDeclaration,
  violations: string[]
): void {
  const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1
  const name = ts.isConstructorDeclaration(declaration)
    ? 'constructor'
    : declaration.name?.getText(sourceFile) ?? '<anonymous>'
  const label = `${sourceFile.fileName}:${line} ${name}`
  const comments = ts.getJSDocCommentsAndTags(declaration)
    .filter((comment): comment is ts.JSDoc => comment.kind === ts.SyntaxKind.JSDocComment)
  const tags = ts.getJSDocTags(declaration)
  const privateMember = declaration.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
  ) === true

  if (privateMember) {
    const raw = comments.map((comment) => comment.getText(sourceFile).trim())
    if (raw.length !== 1 || raw[0] !== '/** @private */') {
      violations.push(`${label}: private class members require only /** @private */`)
    }
    return
  }

  if (comments.length !== 1 || !usefulComment(comments[0]?.comment)) {
    violations.push(`${label}: missing a plain-text JSDoc description`)
  }
  if (placeholderComment(comments[0]?.comment)) {
    violations.push(`${label}: JSDoc description must explain observable behavior`)
  }

  const parameterTags = tags.filter(ts.isJSDocParameterTag)
  const documentedParameters = new Set(parameterTags.map((tag) => tag.name.getText(sourceFile)))
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      violations.push(`${label}: destructured parameters must use a stable documented name`)
      continue
    }
    if (!documentedParameters.has(parameter.name.text)) {
      violations.push(`${label}: missing @param for ${parameter.name.text}`)
    }
  }
  for (const tag of parameterTags) {
    if (
      tag.typeExpression == null ||
      !usefulComment(tag.comment) ||
      placeholderComment(tag.comment) ||
      !/\s-\s/.test(tag.getText(sourceFile))
    ) {
      violations.push(`${label}: @param ${tag.name.getText(sourceFile)} needs a type, dash, and description`)
    }
  }

  if (!ts.isConstructorDeclaration(declaration)) {
    const returnTag = tags.find(ts.isJSDocReturnTag)
    if (
      returnTag?.typeExpression == null ||
      !usefulComment(returnTag.comment) ||
      placeholderComment(returnTag.comment)
    ) {
      violations.push(`${label}: missing typed, described @returns`)
    }
  }

  const documentedThrows = new Set(
    tags
      .filter(ts.isJSDocThrowsTag)
      .map((tag) => tag.typeExpression?.type.getText(sourceFile))
      .filter((type): type is string => type != null)
  )
  for (const tag of tags.filter(ts.isJSDocThrowsTag)) {
    if (tag.typeExpression == null || !usefulComment(tag.comment) || placeholderComment(tag.comment)) {
      violations.push(`${label}: @throws needs a specific type and condition`)
    }
  }
  for (const errorType of directThrownErrorTypes(declaration)) {
    if (!documentedThrows.has(errorType)) {
      violations.push(`${label}: missing @throws {${errorType}} for a direct throw`)
    }
  }
}

function directThrownErrorTypes (declaration: DocumentedDeclaration): Set<string> {
  const errorTypes = new Set<string>()
  const body = declaration.body
  if (body == null) return errorTypes

  function visit (node: ts.Node): void {
    if (node !== body && ts.isFunctionLike(node)) return
    if (
      ts.isThrowStatement(node) &&
      ts.isNewExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      errorTypes.add(node.expression.expression.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(body)
  return errorTypes
}

function usefulComment (comment: string | ts.NodeArray<ts.JSDocComment> | undefined): boolean {
  if (typeof comment === 'string') return comment.trim().length > 1
  return comment != null && comment.length > 0
}

function placeholderComment (comment: string | ts.NodeArray<ts.JSDocComment> | undefined): boolean {
  if (typeof comment !== 'string') return false
  return (
    /^Computes .* from the supplied inputs\.$/.test(comment) ||
    comment.includes('value consumed by the operation') ||
    comment === 'The computed result.' ||
    comment.includes('The value to parse, normalize, or validate') ||
    comment.includes('Whether the inspected values satisfy the condition') ||
    comment.includes('The resolved result') ||
    comment.includes('caller-supplied operation options') ||
    /^Parses .* into its validated representation\.$/.test(comment) ||
    comment === 'Normalizes id for consistent processing.' ||
    /^Validates .* and rejects invalid values\.$/.test(comment)
  )
}
