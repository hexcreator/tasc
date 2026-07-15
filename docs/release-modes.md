# Release Modes

Tasc needs release channels that match the risk level of the protocol. A docs-only release and a mainnet settlement release should not carry the same promises.

## Channels

| Channel | Tag Pattern | Audience | Guarantees |
| --- | --- | --- | --- |
| Snapshot | none or `snapshot-YYYYMMDD` | Contributors and reviewers | Current source state only. No stability promise. |
| Devnet Proof | `v0.x.y-devnet.n` | Protocol builders | Reproducible devnet proof with public transaction/account evidence. |
| Testnet MVP | `v0.x.y-testnet.n` | Early integrators | End-to-end buyer/worker/verifier loop on public testnet/devnet. |
| Mainnet Alpha | `v0.x.y-alpha.n` | Controlled pilots | Limited scope, guarded funds, documented risks, audit plan. |
| Stable Protocol | `v1.x.y` | Ecosystem builders | Versioned task/intents/funding schemas and migration policy. |

## Artifact Modes

### Source Snapshot

Use for docs, examples, validators, and local simulations.

Required checks:

```sh
npm run validate:dependencies
npm run validate:indexer
npm run validate:solana-spl-escrow
```

### Devnet Proof Release

Use when publishing live Solana or Base testnet evidence.

Required checks:

```sh
npm run validate:dependencies
npm run validate:solana-source
npm run validate:solana-spl-escrow
npm run validate:solana-live-scan
npm run index:admit-solana-spl-live
```

Release notes should include:

- program id or escrow address
- transaction signatures
- task account or event coordinates
- admitted index output path
- known limitations

### Testnet MVP Release

Use when the live flow includes:

```text
buyer funds -> indexer admits -> worker claims -> verifier attests -> escrow releases/refunds
```

Required additions before this mode:

- program-signed SPL token release/refund CPI
- scanner output for post-funding lifecycle state
- duplicate claim and timeout tests

### Mainnet Alpha Release

Do not publish this mode until:

- Apache-2.0 licensing is preserved across source and artifacts
- security disclosure process exists
- key management policy is documented
- contract/program review has happened
- fund limits and circuit breakers exist
- dependency audit and artifact provenance are recorded

## Versioning Guidance

Until `v1`, prefer explicit prerelease tags:

```text
v0.1.0-devnet.1
v0.2.0-testnet.1
v0.3.0-alpha.1
```

Schema-breaking changes before `v1` are allowed, but release notes must call out migrations for:

- TascLang syntax
- signed intent shape
- funding evidence shape
- index entry shape
- Solana account layout
- EVM escrow ABI

## Release Checklist

1. Run the channel-specific checks.
2. Confirm `.env*`, keypair files, and local targets are ignored.
3. Update `docs/progress-assessment.md`.
4. Update README live proof facts if public evidence changed.
5. Commit with a clear release-prep message.
6. Create a GitHub release as prerelease unless it is a stable protocol release.
7. Include exact validation commands and transaction/account evidence.
