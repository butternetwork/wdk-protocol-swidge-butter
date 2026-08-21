---
title: Tether Review Compliance - Plan
type: fix
date: 2026-08-21
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Tether Review Compliance - Plan

## Goal Capsule

- **Objective:** Close the actionable Tether review findings for the WDK badge, JSDoc completeness, and WDK dependency compatibility without changing protocol behavior or exported TypeScript signatures.
- **Authority order:** Tether's supplied review and badge asset; WDK Types & JSDoc rules; `AGENTS.md`; existing repository conventions.
- **Execution profile:** Documentation, package metadata, static compliance checks, generated `dist/` artifacts, and compatibility verification.
- **Stop condition:** Do not report the full Tether review as passed while the repository remains private unless Tether grants a written exception or alternative acceptance path.
- **Tail owner:** The implementation owner prepares the code changes and evidence; the project owner obtains and records the Tether visibility exception before launch.

---

## Product Contract

### Summary

Bring the package into verifiable compliance with the three actionable technical findings while preserving the project owner's decision to keep the source repository private.

### Problem Frame

Tether accepted the package structure, license, TypeScript declarations, dependency security, tests, README content, and Bare compatibility, but rejected the README badge, JSDoc coverage, current WDK version, and private source visibility.

The current code has broad prose comments but not WDK-complete JSDoc: an AST inventory found 197 named function-like declarations, 103 without a JSDoc block, 186 with at least one undocumented parameter, 182 without `@returns`, and no `@throws` tags. The reviewer-requested `@tetherto/wdk-wallet@1.0.0-beta.15` is now the minimum historical target; npm `latest` has advanced to `1.0.0-beta.17`.

### Requirements

- R1. README displays the supplied neutral black "Built with WDK" badge and links it to the official WDK documentation.
- R2. Every named function declaration, constructor, and method in `src/` has WDK-compliant documentation, with complete parameter, return, and applicable thrown-error information under the visibility rules in KTD2.
- R3. The package supports `@tetherto/wdk-wallet` from `1.0.0-beta.15` onward and is developed, locked, and verified against the current npm `latest`, `1.0.0-beta.17`.
- R4. Source and generated declarations expose the same types and documentation; implementation behavior and exported TypeScript signatures do not change.
- R5. The repository remains private, so launch approval depends on a written Tether exception rather than claiming the open-source finding is fixed.

### Success Criteria

- The README renders the exact supplied `Frame 6949.png` artwork, renamed to a stable repository filename; its SHA-256 remains `6a9ba1dc25883ac4586e63ecf723cab9d194dd2e3b592e936ae9c37c6044dd5e`.
- The JSDoc compliance check reports no missing descriptions, parameters, returns, visibility markers, or direct thrown-error annotations for declarations in scope.
- Clean compatibility verification succeeds with both the minimum supported WDK version (`beta.15`) and the current latest version (`beta.17`).
- Tests, type checks, build, package-content inspection, and dependency audit pass; regenerated `dist/` files are committed.
- The review response distinguishes the three closed technical findings from the unresolved visibility finding and links the written exception before launch.

### Key Decisions

- **Repository remains private.** (session-settled: user-directed - chosen over making the repository public before launch: repository visibility is fixed by the project owner.) Governs R5.
- **Document all named declarations.** (session-settled: user-directed - chosen over public-API-only coverage: the review's literal "all functions" wording makes narrower coverage likely to fail again.) Governs R2.

### Scope Boundaries

- No protocol routing, validation, fee, execution, or status behavior changes.
- No new public exports or TypeScript signature changes.
- Inline anonymous callbacks are excluded; named object-literal methods remain in scope.
- Repository publicization is excluded by project-owner decision. Obtaining Tether's exception is an external launch activity, not a code change.
- Exact-out support, chain support, and unrelated documentation cleanup remain out of scope.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Vendor the neutral badge asset.** Copy the supplied `Frame 6949.png` to `docs/assets/built-with-wdk.png`, preserve its bytes, add meaningful alt text and fixed dimensions near the README title, and link to `https://docs.wdk.tether.io/`. Include the asset in the npm package file list so the published artifact contains the reviewed image. Governs R1.
- KTD2. **Apply WDK visibility-specific JSDoc.** Module-level named functions, constructors, public/protected methods, and named object-literal methods receive a plain-language description, one meaningful `@param` per parameter, `@returns` for every non-constructor including `void`, and specific `@throws` entries for direct or intentionally propagated errors. TypeScript `private` class members receive only `/** @private */` per WDK R6. Overrides specialize the upstream WDK contract to the Butter error behavior rather than using generic `Error`. Governs R2 and R4.
- KTD3. **Enforce structure with the existing TypeScript compiler API.** Extend the documentation compliance coverage with an AST-based scan rather than adding ESLint or another dependency. The scan covers the declaration set in KTD2, handles constructors and destructured parameters explicitly, validates descriptions before tags, and checks exact parameter/return coverage plus direct `throw` sites. Semantic accuracy of `@throws` remains a WDK review gate because static analysis cannot prove all transitive failures. Governs R2.
- KTD4. **Separate minimum compatibility from the development lock.** Raise the peer range floor to `>=1.0.0-beta.15 <2.0.0`, pin the dev dependency and lockfile to `1.0.0-beta.17`, and verify both endpoints. This satisfies the reviewer-requested minimum without falsely calling an older beta the current latest. Governs R3.
- KTD5. **Regenerate declarations from TypeScript source.** This repository's `dist/` is compiler-owned; run the normal build and commit emitted JavaScript, declarations, and maps. Do not hand-edit generated declarations even though the generic JavaScript WDK rule describes manual `.d.ts` maintenance. Governs R4.

### Sequencing

1. Establish dependency compatibility and update package metadata.
2. Add the reviewed badge and documentation/package assertions.
3. Complete public-contract JSDoc, then internal named declarations and the structural gate.
4. Regenerate `dist/`, update release notes, and run the full verification contract.
5. Submit the technical fixes with the private-repository exception identified as a separate launch gate.

### Risks & Dependencies

- `beta.17` changed WDK's inherited `swap`/`quoteSwap`/`bridge`/`quoteBridge` error wrapping and exact optional types. Existing legacy delegation and error-propagation tests must prove Butter's observable behavior remains unchanged.
- Structural JSDoc checks can prove tag presence but not whether descriptions or transitive error lists are correct. A final `wdk-review-types-jsdoc` pass is required.
- A relative README image renders for authorized repository viewers, but the public npm page may rewrite it through the private repository URL. Verify npm rendering after release; if it fails, the badge finding stays open until Tether approves a public asset host.
- Keeping the repository private directly conflicts with Tether's stated launch requirement. No code change mitigates this; only written acceptance does.

---

## Implementation Units

### U1. WDK Version Contract

- **Goal:** Support Tether's requested minimum and build against the actual current stable WDK release.
- **Requirements:** R3, R4; KTD4.
- **Dependencies:** None.
- **Files:** `package.json`, `package-lock.json`, `test/butter-swidge-protocol.test.ts` if a compatibility regression needs explicit coverage.
- **Approach:** Raise only the peer floor, use an exact dev version for reproducible builds, refresh the lockfile, and preserve the existing `<2.0.0` consumer range. Review the `beta.15` to `beta.17` Swidge base-class changes and keep Butter errors and legacy mappings stable.
- **Patterns to follow:** Existing exact-in and legacy `swap`/`bridge` delegation tests.
- **Test scenarios:**
  - Install the package with peer version `beta.15`; type checking, unit tests, and build complete without source changes specific to the newer beta.
  - Install with `beta.17`; `quoteSwidge`, `swidge`, status, discovery, and generated declarations compile.
  - Under `beta.17`, inherited legacy swap and bridge methods preserve current result mapping and propagate Butter-specific exact-out/configuration errors without unexpected WDK wrapping.
- **Verification:** The manifest expresses the minimum/latest distinction, the lock resolves `beta.17`, and both clean compatibility runs pass.

### U2. Official README Badge

- **Goal:** Display the exact Tether-supplied badge and preserve it in the published package.
- **Requirements:** R1, R4; KTD1.
- **Dependencies:** None.
- **Files:** `docs/assets/built-with-wdk.png`, `README.md`, `package.json`, `test/documentation.test.ts`, `test/release-config.test.ts`.
- **Approach:** Copy the vendor asset without recompression, add the linked badge directly below the package title, and add the new asset path to the package file allowlist.
- **Patterns to follow:** Existing README compliance assertions and package-content assertions.
- **Test scenarios:**
  - The asset hash equals the reviewed SHA-256 value and its PNG dimensions remain 240 by 60.
  - README references the stable asset path, exposes meaningful alt text, and links to the official WDK docs.
  - Package dry-run output includes the badge asset.
- **Verification:** GitHub's private-repository README view renders the badge for an authorized reviewer, and the packed artifact contains the exact image.

### U3. Public Contract JSDoc

- **Goal:** Make the package entrypoint and WDK override surface fully understandable in generated IDE documentation.
- **Requirements:** R2, R4; KTD2, KTD5.
- **Dependencies:** U1.
- **Files:** `src/protocol.ts`, `src/errors.ts`, `src/amounts.ts`, `src/slippage.ts`, `src/evm.ts`, `src/types.ts`, `src/index.ts`.
- **Approach:** Document public classes, constructors, exported functions/types, configuration fields, and WDK overrides. Use the concrete Butter error classes and conditions in `@throws`; retain TypeScript as the type source rather than duplicating wider JSDoc types.
- **Patterns to follow:** WDK JSDoc R1, R3, R4, R8, R17, R21, and R28; the upstream `beta.17` Swidge method documentation, specialized to actual Butter behavior.
- **Test scenarios:**
  - Every entrypoint export has a meaningful source description that survives in the corresponding `dist/*.d.ts` declaration.
  - Each public/protected method documents every parameter, return, and observable error family with no generic `Error` fallback.
  - Optional defaults are described in prose and no JSDoc tag precedes its description.
- **Verification:** TypeScript signatures remain byte-for-byte equivalent apart from dependency-driven upstream types and added comments; generated declarations contain the new documentation.

### U4. Internal Named-Declaration JSDoc Gate

- **Goal:** Close the reviewer's literal all-functions gap and prevent documentation coverage from regressing.
- **Requirements:** R2, R4; KTD2, KTD3.
- **Dependencies:** U3.
- **Files:** `src/*.ts`, `test/documentation.test.ts`.
- **Approach:** Complete JSDoc across the remaining routing, fee, discovery, HTTP, identifier, mapping, status, transaction-validation, and registry functions. Use minimal `@private` blocks for private class members, full blocks elsewhere, and adjust destructured parameters only when a stable parameter name is necessary for correct documentation. Add an AST-backed compliance assertion using the existing TypeScript dependency.
- **Patterns to follow:** Existing trust-boundary prose in `src/fees.ts`, `src/swap-data.ts`, and `src/protocol.ts`; WDK visibility and completeness rules.
- **Test scenarios:**
  - The AST scan finds every named declaration and reports zero missing description/visibility blocks.
  - Non-private declarations have exact parameter tags and a return tag; constructors omit returns; private class members contain only the minimal marker.
  - Functions with direct throw sites contain specific `@throws` tags, while inline anonymous callbacks remain excluded.
  - Running the check against a fixture or deliberately incomplete in-memory source reports the exact missing rule, declaration, and file location.
- **Verification:** The compliance test passes over all `src/` modules and the final WDK review reports no function-documentation violations.

### U5. Generated Artifacts and Review Evidence

- **Goal:** Produce a reviewable release candidate and clearly separate closed findings from the private-repository exception.
- **Requirements:** R1-R5; KTD5.
- **Dependencies:** U1-U4.
- **Files:** `dist/*`, `CHANGELOG.md`, `RELEASING.md`.
- **Approach:** Regenerate all compiler-owned outputs, record the badge/JSDoc/dependency changes under Unreleased, and add the Tether visibility exception to the launch checklist without changing repository metadata or `publishConfig`.
- **Test scenarios:**
  - Generated JavaScript and declarations differ only by comments, source maps, and upstream type effects; runtime exports remain unchanged.
  - The packed tarball contains README, badge, declarations, and runtime files and contains no local attachment path or private credential.
  - The reviewer response marks badge, JSDoc, and WDK compatibility closed, but marks source visibility as waived or still blocking based on written Tether evidence.
- **Verification:** Full repository checks pass, the worktree contains intentional generated changes only, and launch status accurately reflects the unresolved visibility requirement.

---

## Verification Contract

| Gate | Command or evidence | Done signal |
|---|---|---|
| Documentation compliance | `npm test` plus `wdk-review-types-jsdoc src/` | AST gate and WDK rule review report zero in-scope violations |
| Type safety | `npm run typecheck` | Library, examples, and tests compile under strict TypeScript |
| Generated output | `npm run build` | `dist/` is current and exported signatures are unchanged |
| Package contents | `npm pack --dry-run` | Badge, README, runtime files, declarations, and maps are present |
| Dependency health | `npm audit` | No known install-time vulnerabilities are introduced |
| Compatibility minimum | Clean install with `@tetherto/wdk-wallet@1.0.0-beta.15` followed by test, typecheck, and build | Minimum supported peer remains usable |
| Compatibility latest | Clean install from the committed lockfile resolving `@tetherto/wdk-wallet@1.0.0-beta.17` followed by test, typecheck, and build | Current npm latest is the development baseline |
| Badge fidelity | SHA-256 and 240 by 60 dimension assertions | Repository asset exactly matches the supplied neutral badge |
| Visibility exception | Written Tether approval attached to the launch/review record | Private repository is accepted; otherwise launch remains blocked |

---

## Definition of Done

- U1: Peer range starts at `beta.15`, dev/lock resolve `beta.17`, and both compatibility endpoints pass.
- U2: The exact supplied badge renders in README and is included in the package tarball.
- U3: Public API, override methods, constructors, types, parameters, returns, defaults, and thrown errors are fully documented in source and generated declarations.
- U4: Every named declaration is covered under the agreed scope and the AST compliance gate prevents regression.
- U5: `dist/`, changelog, release guidance, tests, type checks, build, audit, and package inspection are complete.
- No protocol behavior, public export, or exported TypeScript signature changed unintentionally.
- The three technical findings are ready for Tether re-review.
- The overall launch review is not represented as fully approved until Tether explicitly accepts the private repository.

---

## Appendix

### Sources & Research

- Tether reviewer feedback supplied in this session.
- Tether-supplied neutral badge asset, `Frame 6949.png`, inspected at 240 by 60 pixels and pinned by SHA-256 in R1.
- [`@tetherto/wdk-wallet` npm versions](https://www.npmjs.com/package/@tetherto/wdk-wallet?activeTab=versions), showing `1.0.0-beta.17` as npm `latest` on 2026-08-21.
- [WDK Swidge protocol source](https://github.com/tetherto/wdk-wallet/blob/main/src/protocols/swidge-protocol.js), used for override documentation and `@throws` conventions.
- Repository patterns in `test/documentation.test.ts`, `test/release-config.test.ts`, `src/protocol.ts`, and generated `dist/*.d.ts`.
- No repo-local `STRATEGY.md`, `CONCEPTS.md`, or institutional `solutions/` corpus exists for this scope.
