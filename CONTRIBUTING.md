# Contributing To Tasc

Tasc is an early protocol prototype. Contributions are welcome, but the project should stay rigorous: every change should make the system easier to verify, safer to run, or clearer to evaluate.

## Current Contribution Status

The repository is public, but a project license has not been selected yet. Until a `LICENSE` file is added, avoid submitting substantial original code. Issues, design feedback, docs improvements, typo fixes, and small reproducibility fixes are fine.

Recommended next legal step: choose `MIT`, `Apache-2.0`, or a dual-license strategy before inviting broad code contributions.

## Good First Areas

- Improve TascLang examples and verifier fixtures.
- Add clearer walkthroughs for buyers, workers, verifiers, and indexer operators.
- Harden scanner/admission tests around mismatched or stale funding evidence.
- Make the static web feed easier to run locally.
- Convert live devnet proof commands into safer scripted walkthroughs.

## High-Impact Areas

- Live Solana `claim`, `attest`, `release`, and `refund` instructions.
- Solana account discovery/indexing beyond single known task accounts.
- Worker claim lock semantics and timeout behavior.
- Verifier service boundaries, artifact hashes, and result attestations.
- Release automation and signed artifact generation.

## Development Setup

Install dependencies:

```sh
npm install
```

Run a focused local validation set:

```sh
npm run compile:example
npm run verify:example
npm run demo:market
npm run validate:indexer
npm run validate:solana-spl-escrow
npm run validate:dependencies
```

Run Solana source validation if Rust/Cargo is available:

```sh
npm run validate:solana-source
```

Live devnet commands can spend devnet SOL and mutate public devnet state. They are guarded by explicit environment flags and should not be run casually.

## Pull Request Expectations

Before opening a PR:

- Keep the scope narrow and explain the protocol boundary being changed.
- Include validation output in the PR description.
- Add or update tests for scanner, admission, settlement, or verifier changes.
- Do not commit `.env*`, private keys, wallet keypairs, RPC URLs, or generated local target directories.
- Do not add runtime dependencies unless there is a clear reason and a security review.

PR descriptions should include:

- what changed
- why it matters
- validation commands run
- risks or incomplete parts
- whether any live-chain state was touched

## Security Rules

- Never post private keys, seed phrases, paid RPC URLs, or auth tokens in issues or PRs.
- Treat all live settlement code as unsafe until audited.
- Prefer deterministic fixtures over live network calls in normal tests.
- Use explicit guard env vars for any command that can send a transaction.

## Style

- Keep core tools dependency-light.
- Prefer simple JSON fixtures and explicit validators.
- Keep chain-specific code behind adapter boundaries.
- Write docs that tell users what is proven, what is simulated, and what is still missing.
