# Releasing

This repository publishes the public scoped package
`@butternetwork/wdk-protocol-swidge-butter` to the npm registry. The package
manifest fixes both the public access level and the registry, while
`.github/workflows/publish.yml` handles subsequent releases through npm Trusted
Publishing. Do not add an `NPM_TOKEN` to that workflow: it authenticates with a
short-lived GitHub Actions OIDC token.

## Tether review gate

This source repository remains private by project-owner decision. Tether's launch
review requires publicly accessible source, so a release must not describe that
finding as fixed. Before launch, attach Tether's written exception or alternative
acceptance path to the release record; without that evidence, the Tether review
remains blocked even when the package's technical checks pass.

## First publish

npm requires the package to exist before its Trusted Publisher can be configured.
An npm maintainer in the `butternetwork` organization must therefore bootstrap a
new package once from a trusted workstation with 2FA enabled:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm login --scope=@butternetwork --registry=https://registry.npmjs.org
npm whoami
npm publish --access public
```

After that publish, open the package settings on npmjs.com and add this Trusted
Publisher:

- Provider: GitHub Actions
- Organization or user: `butternetwork`
- Repository: `wdk-protocol-swidge-butter`
- Workflow filename: `publish.yml`
- Environment: none
- Allowed action: `npm publish`

Publish one release through the workflow before changing the package's npm
publishing access to "Require two-factor authentication and disallow tokens".
Trusted Publishing will continue to work because it does not use traditional npm
tokens.

## Subsequent releases

Prepare the release on `main`: update the package version without creating an
automatic Git commit, move the relevant CHANGELOG entries out of `[Unreleased]`,
run the release checks, and commit the release changes.

```sh
npm version patch --no-git-tag-version
# Use minor, major, or an explicit prerelease version when appropriate.
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Create and publish a GitHub Release whose tag is exactly `v` followed by the
`package.json` version, for example `v0.1.1`. The publish workflow checks this
match before contacting npm. A regular GitHub Release publishes under the npm
`latest` tag; a GitHub prerelease publishes under `next`.

Before publishing, the workflow also checks the exact package version in the npm
registry. A missing version (`E404`) is published normally. An existing version
is treated as a successful no-op only when its npm `gitHead` matches the Release
tag commit; a missing, malformed, or different `gitHead`, or any other registry
error, fails the workflow without publishing.

This allows a GitHub Release to be backfilled after a manual npm publish. Push a
tag at the commit reported by `npm view <package>@<version> gitHead`, merge the
idempotent workflow into the default branch, and only then publish the Release.
Do not move the tag to a later documentation or release-automation commit.

Trusted Publishing requires a GitHub-hosted runner and the workflow's
`id-token: write` permission. Public packages built from public repositories also
receive npm provenance automatically. A private repository can still use Trusted
Publishing, but npm does not generate provenance for it.
