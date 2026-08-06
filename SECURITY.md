# Security Policy

## Scope

This policy covers security vulnerabilities in this repository and in the
published `@butternetwork/wdk-protocol-swidge-butter` npm package. If you are
unsure whether an issue belongs to this package or to an upstream service or
dependency, report it privately through one of the channels below. We will help
route the report to the appropriate maintainer.

## Supported Versions

Security fixes are provided for the latest stable release published under the
npm `latest` dist-tag. Users of older releases must upgrade to receive security
fixes.

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Do not disclose a suspected vulnerability in a public GitHub issue, discussion,
pull request, or other public channel.

Use one of these private channels:

1. Submit a [private vulnerability report](https://github.com/butternetwork/wdk-protocol-swidge-butter/security/advisories/new)
   through GitHub. This is the preferred channel.
2. Email [business@butternetwork.io](mailto:business@butternetwork.io) with a
   subject beginning `[SECURITY]` if GitHub private reporting is unavailable or
   you need an alternate channel.

Include as much of the following information as possible:

- the affected package version or commit;
- a description of the vulnerability and its expected impact;
- reproducible steps or a minimal proof of concept;
- affected chains, tokens, routes, or configuration, when relevant;
- required privileges, preconditions, and known mitigations; and
- whether you want public credit or prefer to remain anonymous.

Do not send seed phrases, private keys, API secrets, credentials, or funds. Use
redacted logs and test credentials with no real-world value.

## Response and Disclosure

We will acknowledge a report within three business days. Within ten business
days, we will provide an initial assessment covering the likely severity,
affected scope, and next remediation steps. Remediation time depends on the
severity, complexity, and any required coordination with upstream maintainers.

Please keep the report confidential while we investigate and prepare a fix. We
will coordinate public disclosure when a fixed release is available. If a fix
cannot be released sooner, the default disclosure deadline is 90 calendar days
after we receive the report. The reporter and maintainers may agree in writing
to a different date.

With the reporter's consent, a public advisory may credit the individuals or
organizations who reported the issue. Requests for anonymity will be honored.

## Safe Harbor

We will not initiate legal action against researchers who act in good faith,
comply with this policy, and make a reasonable effort to avoid harm. Good-faith
research must:

- use local environments or test networks whenever practical;
- avoid privacy violations, service degradation, denial of service, social
  engineering, phishing, and physical attacks;
- avoid accessing, modifying, retaining, or destroying data beyond what is
  necessary to demonstrate the issue;
- never move, retain, or put user or project funds at risk;
- stop testing and report promptly after confirming the vulnerability; and
- comply with applicable law and keep vulnerability details confidential during
  the coordinated disclosure period.

This safe harbor applies only to systems and code we control. It cannot bind
third parties, service providers, or law enforcement.

## Rewards

This project does not currently operate a bug bounty program and does not
promise payment or other compensation for vulnerability reports.
