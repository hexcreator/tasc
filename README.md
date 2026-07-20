<p align="center">
  <img src="assets/tasc-wordmark.svg" alt="Tasc: pre-funded micro-work, verifiable settlement" width="100%">
</p>

<p align="center">
  <a href="https://github.com/hexcreator/tasc"><img alt="Repo" src="https://img.shields.io/badge/repo-hexcreator%2Ftasc-102520?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-mainnet%20proof-45E0B8?style=flat-square">
  <img alt="Runtime deps" src="https://img.shields.io/badge/runtime%20deps-zero-7DD3FC?style=flat-square">
  <img alt="Settlement" src="https://img.shields.io/badge/settlement-Solana%20%2B%20EVM-F8C35B?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-8A8F98?style=flat-square">
</p>

# Tasc

Tasc is an early protocol prototype for instant micro-work: buyers publish pre-funded tasks, workers claim and complete them, verifiers check the result, and escrow pays out when proof passes.

The target is deliberately narrow: make small jobs, like `$10` tasks, globally claimable in about a minute. That only works if the work is already funded or payment-authorized before a worker starts.

> This repository is a research prototype with one controlled Solana mainnet USDC payout proof. It is not audited and is not safe for unsupervised public funds.

## What Exists Now

Tasc currently proves the hard protocol boundary: a task can be compiled, signed, funded, scanned, and admitted as claimable inventory only when funding evidence matches the buyer intent.

| Layer | Current Proof |
| --- | --- |
| Task language | `TascLang` compiles a constrained task contract into canonical JSON and a stable task hash. |
| Buyer authorization | EIP-712 and Solana Ed25519 signed intents bind task hash, input hash, amount, token, deadline, verifier, and nonce. |
| Settlement | EVM escrow surface plus live Solana program/account model. |
| Solana custody | Live devnet SPL `TransferChecked` into a fresh task vault. |
| Indexer gate | Funding evidence is admitted only when it matches the signed intent and custody proof. |
| Static discovery | Browser-side scanner/feed proof with JSON index import, signed task inputs, and no hosted backend requirement. |
| Worker proof | Browser-side markdown submission capture derives verifier-compatible result hashes and proof JSON. |
| Verifier bridge | Captured worker proof JSON ingests into `tasc.attestation` plus Solana-ready attest hashes. |
| Verifier API | Dependencyless HTTP wrapper exposes proof ingestion at `/v1/ingest`, and the static app can submit captured proofs to it. |
| Wallet operator | Browser-side and guarded local Solana claim/attest/release/refund/timeout-refund transaction submission paths. |

Current Solana mainnet USDC proof:

```text
program id:      FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM
usdc mint:       EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
task account:    G3tbuXWGXFPZGLVbiJvPp6iWHoP7eS3rbsarZ4AGrpqx
fund tx:         3aegCSLiMak8BYwuXux1sUUcK1T5gVNEdEM1bZ4PR2PG7h9aMijp9pMN5oLFW2MdSDYgEs8VgnjpQHJVuyuwFUUE
claim tx:        55DphbFxouhdH97Q8Qu27z9WQ8Uw2rEPpqdAkx5R1oDn9ewMN4EnWUzs4gzPPdDbAn5sp35PUKT6v1WtCagqPfAS
attest tx:       4XqT8XWS7Cb7Wsh5d9dv15LdDTbjrN44xxaYUAYsKftzZ8G1TnZoe5GEpft3xugjZPXMPaypPUrTUfoNPdRo94ik
release tx:      2LBTQAv6cvh5q28QfNGdP1bUAmRVdycbzRVfrmLCyfSxQgKZu759xhHypUpSUKT8k6qAvQ4zSUw9iWDRE1eHCUXU
claim->release:  19852ms
final status:    Released
```

Current live Solana SPL proof:

```text
program id:   FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM
fund tx:      zhrqMMYfXQAK37hLVkuvmqNwb2VzkdM4ZyHZMhpBhci97j3L38A7dswKhA9PsjimMPEFczf9NoWu5pR4jnudsm1
task account: 37hA4KUeR6eLPP1g1mBoTMYHKCPq7LECpLryQc61TmRi
vault token:  ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4
claim tx:     3eQLPK2SsMFJySopM6W27YapKLAoxdFANy9qjf4JjoXe3suSt8yZLZrruFCTzBfqAkF4MvXPNieFQFasSoY4rBG6
attest tx:    4ttsWrawCvg3v981Yyrsy8SYpr9ayzYmfLeVK72bvQmUBEHaaGyEiVCE9MLY3hYiTtR1ZZrS3NmMSsBnYA9sMUw1
worker token: 8KJmiwZR42u5pv5CKkxap6qFE1LYu4bKKye5DWXxbUJ8
amount:       10000000 base units
index:        examples/index/solana.spl.live.index.json
release plan: examples/solana-devnet/summarize_url_spl.release-plan.live.json
```

## Architecture

<p align="center">
  <img src="assets/tasc-architecture.svg" alt="Tasc architecture diagram" width="100%">
</p>

The protocol keeps the task definition chain-agnostic. Settlement adapters can target EVM or Solana, but every claimable task must pass the same admission rule:

```text
signed buyer intent + matching funding evidence -> claimable task index
```

## Quick Start

Requirements:

- Node.js 20+
- npm
- Rust/Cargo only for the Solana source validator
- Solana CLI only for live devnet deploy/send flows

Install dependencies:

```sh
npm install
```

Run the safe local demo:

```sh
npm run demo
```

Or run the same pieces manually:

```sh
npm run compile:example
npm run verify:example
npm run demo:market
npm run validate:indexer
npm run validate:verifier-ingest
npm run validate:verifier-api
npm run validate:solana-spl-escrow
npm run validate:dependencies
```

Inspect the task language:

```sh
node bin/tasclang.js compile examples/summarize_url.tasc
```

Inspect the existing live Solana SPL custody proof without sending transactions:

```sh
npm run devnet:proof
```

The output is a worker-facing claimable index entry at:

```text
examples/index/solana.spl.live.index.json
```

## Example Task

```tasc
tasc summarize_url {
  version "0.1"
  reward 10 USDC
  deadline 60s

  input url string
  output markdown string

  verify {
    min_words 120
    contains_citation input.url
    no_duplicate worker
  }

  payout {
    pass -> worker
    timeout -> buyer
    dispute -> reviewers(3)
  }
}
```

## Settlement Flow

<p align="center">
  <img src="assets/tasc-flow.svg" alt="Tasc settlement flow" width="100%">
</p>

The implemented local simulation covers:

```text
funded -> claimed -> passed -> released
```

The live Solana devnet path currently covers:

```text
signed intent -> SPL vault custody -> funded task account -> scanner -> claimable index -> live claim -> live verifier attest -> live program-signed SPL release/refund -> completed index
```

The current Solana program and CLI support program-signed SPL Token `TransferChecked` CPI for `release` and `refund`. Live devnet proofs have released `10000000` token base units from a PDA-owned vault to the worker token account, and refunded `10000000` token base units from a fresh failed task back to the buyer token account.

The timeout-aware Solana artifact also enforces Clock-backed claim deadlines and timeout refund eligibility for `Funded` or `Claimed` tasks. A live devnet timeout refund proof now refunds an overdue funded task back to the buyer without a worker claim or verifier failure.

The static browser operator console can now import index/proof artifacts, show the signed input URL plus verifier rules for each task, capture markdown output as `tasc.worker.submission` proof JSON, derive the verifier-compatible result hash, submit that proof to the verifier API, persist the returned `tasc.verifier.ingestion`, fill the Solana attest verdict/hash controls, build the same Solana lifecycle transaction payloads without runtime dependencies, and submit them through an injected wallet provider. The verifier ingestion path has a dependencyless HTTP API wrapper:

```bash
TASC_VERIFIER_API_TOKEN=dev-token \
npm run verifier:api
```

That starts the verifier with bearer-token auth, a persistent duplicate ledger at `.tascverifier/ledger.json`, and durable ingestion artifacts under `.tascverifier/artifacts/`. Enter the API URL and bearer token in the static app's Verifier API panel, capture a worker proof, then use `Submit to Verifier` to call `POST /v1/ingest` from the browser.

For the local private-beta operator session, run:

```bash
npm run beta:plan
npm run beta:local
npm run beta:qa
npm run beta:feed
npm run beta:claimable:plan
npm run beta:session:plan
```

`beta:local` serves the static app and verifier API together on localhost, prints the app URL, verifier URL, local config URL, and bearer token, writes verifier artifacts under `.tascverifier/`, and lets the app auto-fill the Verifier API panel from same-origin local config. After a wallet-extension run, use `Export QA Evidence` to download a redacted `tasc.private_beta.qa_evidence` bundle with feed state, verifier results, and wallet transaction signatures.

`beta:feed` builds the same-origin static feed bundle at `web/feed/proof-feed.json`. The static app's `Load Hosted Feed` button fetches that bundle without a backend, so `web/` can be served by free static hosting. After a fresh devnet proof run, rebuild the hosted feed with:

```bash
npm run beta:feed -- --proof-summary examples/solana-devnet/proofs/<run-id>/proof-summary.json
```

For active private-beta inventory, plan a fresh funded 60-second claimable task with:

```bash
npm run beta:claimable:plan
npm run beta:session:plan
```

The live path is guarded by `GLOBAL_TASC_ALLOW_BETA_CLAIMABLE_PUBLISH=1`. When run, it creates a fresh devnet SPL test-token task, admits it as claimable inventory, and publishes `web/feed/claimable-feed.json`. The static app tries that active feed before falling back to the completed proof feed.

Use `beta:session` when you are ready for wallet-extension QA against a fresh active task:

```bash
GLOBAL_TASC_ALLOW_BETA_CLAIMABLE_PUBLISH=1 npm run beta:session
```

That command publishes a fresh active claimable feed, starts the localhost static app plus verifier API, and points the verifier at `web/feed/active.claimable.index.json` so worker proof ingestion trusts the same task the browser loads through `Load Hosted Feed`.

`beta:qa` prints the wallet QA runbook when no evidence path is provided. Validate a real exported bundle with:

```bash
npm run beta:qa -- ~/Downloads/tasc-private-beta-qa.json \
  --solana-rpc-url https://api.devnet.solana.com
```

That wrapper enforces wallet-send, verifier-ingestion, worker-proof, live-account, and Solana RPC checks. Use `--offline` only for a local schema check; it does not count as a final wallet QA pass.

Headless validation covers the bytes, API auth/persistence behavior, guarded UI, mock wallet-provider submission transports, local verifier auto-fill, QA evidence export wiring, QA evidence redaction checks, optional Solana RPC evidence checks, the local beta launcher, the active-session runner, and the guided QA runner; a real wallet-extension QA pass is still required before treating this as beta-ready UX.

## Repository Map

| Path | Purpose |
| --- | --- |
| `bin/` | Dependency-light CLI tools, validators, scanners, and live devnet harnesses. |
| `contracts/` | Solidity escrow and local ERC-20 test token. |
| `programs/solana-tasc/` | Dependencyless Rust core for Solana task account and instruction bytes. |
| `examples/` | Task specs, signed intents, funding evidence, live devnet scans, and admitted indexes. |
| `docs/` | Protocol, settlement, scanner, release, and operational notes. |
| `web/` | Static browser scanner/feed and Solana operator proof. |
| `assets/` | Repository SVGs and diagrams. |

Useful docs:

- [Protocol V1](docs/protocol-v1.md)
- [Solana Devnet V1](docs/solana-devnet-v1.md)
- [Production Mainnet Runbook](docs/production-mainnet-runbook.md)
- [Indexer Admission V1](docs/indexer-admission-v1.md)
- [Release Modes](docs/release-modes.md)
- [Adoption Plan](docs/adoption-plan.md)
- [Contributing](CONTRIBUTING.md)

## Reproduce The Devnet Proof

The live Solana mechanics can now be packaged as a fresh proof bundle. The safe plan mode does not send transactions:

```bash
npm run prove:solana-devnet:plan
```

The live runner creates fresh task hashes, sets up a devnet SPL test mint, proves release, failure refund, and timeout refund, scans the resulting accounts, and writes completed index evidence under the ignored `examples/solana-devnet/proofs/` directory:

```bash
GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run prove:solana-devnet
```

Do this only with devnet keys and funded devnet SOL balances.

To measure the actual under-60-second payout path on devnet test tokens, use the 60-second command alias:

```bash
npm run earn:devnet:plan
GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run earn:devnet
```

The generated `proof-summary.json` includes `timed_payout`, with claim-to-release timing, claim-to-completed-index timing, the worker destination token account, and explicit `under_60s` booleans. This is still devnet/test-token evidence, not real-money income.

Validate a generated timed proof with:

```bash
npm run validate:timed-payout -- examples/solana-devnet/proofs/<run-id>/proof-summary.json
```

Check whether the real `$10 in less than a minute` goal is actually ready:

```bash
npm run real:env:init:plan -- --env .env.solana-mainnet.local
npm run real:env:init -- --env .env.solana-mainnet.local
# Fill remaining blanks in .env.solana-mainnet.local with public mainnet
# wallet/account values and the private RPC URL. If those values are already
# exported, rerun init with --from-process-env.
npm run real:env:plan -- --env .env.solana-mainnet.local
npm run real:env:validate -- --env .env.solana-mainnet.local

# Safe pause checkpoint. This is read-only, calls no RPC, sends no transactions,
# and reports whether canonical production evidence implies spend already happened.
npm run real:pause:plan -- --env .env.solana-mainnet.local
npm run real:pause -- --env .env.solana-mainnet.local
npm run real:budget:plan -- --env .env.solana-mainnet.local
npm run real:budget -- --env .env.solana-mainnet.local
npm run real:resume:plan -- --env .env.solana-mainnet.local
npm run real:resume -- --env .env.solana-mainnet.local

npm run real:deploy:plan
npm run real:deploy:build -- \
  --env .env.solana-mainnet.local

# Deploy only after reviewing .tascverifier/production-deploy-handoff.json.
# Capture the deploy signature and confirm the same program id is executable.

npm run real:intent:plan
npm run real:intent:build -- examples/summarize_url.tasc \
  --env .env.solana-mainnet.local \
  --input url=<url>

# Sign .tascverifier/production-intent/production-intent.signing-payload.json
# with the buyer wallet, then attach the base58 Ed25519 signature:
npm run real:intent:attach-signature -- \
  --intent .tascverifier/production-intent/production-intent.intent.json \
  --signature <base58-wallet-signature>

npm run real:capture:plan
npm run real:capture:init -- \
  --env .env.solana-mainnet.local \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json

npm run real:preflight:plan
npm run real:preflight -- --env .env.solana-mainnet.local

# If preflight reports missing buyer/worker USDC associated token accounts,
# build setup artifacts, submit each with the matching role wallet, and rerun
# preflight before funding.
npm run real:token-account:plan
npm run real:token-account:build -- --env .env.solana-mainnet.local --role buyer
npm run real:token-account:build -- --env .env.solana-mainnet.local --role worker
npm run real:preflight -- --env .env.solana-mainnet.local

npm run real:fund:plan
npm run real:fund:build -- \
  --env .env.solana-mainnet.local \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json

# Optional guarded wallet submitter: run this in another terminal,
# open the printed production_submitter_url, paste the artifact,
# connect the required role wallet, enable production sends,
# and use the generated capture command.
npm run real:submitter:serve

# Submit .tascverifier/production-fund-transaction.json with the buyer wallet,
# then keep the returned fund signature plus task/vault accounts.
npm run real:capture:record -- \
  --transaction .tascverifier/production-fund-transaction.json \
  --signature <fund-sig>

npm run real:lifecycle:plan
npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action claim \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account>

# Submit .tascverifier/production-lifecycle-claim.json with the worker wallet,
# start the payout timer, then keep the returned claim signature.
npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-claim.json \
  --signature <claim-sig> \
  --claim-started-at <iso-claim-started>

npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action attest \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account> \
  --verdict pass \
  --result-hash <0x-result-hash>

# Submit .tascverifier/production-lifecycle-attest.json with the verifier wallet,
# then keep the returned attest signature.
npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-attest.json \
  --signature <attest-sig>

npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action release \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account>

# Submit .tascverifier/production-lifecycle-release.json with the worker wallet,
# then keep the returned release signature and confirmation timestamp.
npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-release.json \
  --signature <release-sig> \
  --release-confirmed-at <iso-release-confirmed> \
  --completed-indexed-at <iso-completed-indexed>

npm run real:capture:validate
npm run real:capture:payout -- \
  --env .env.solana-mainnet.local

npm run real:packet:plan
npm run real:packet:build -- \
  --env .env.solana-mainnet.local \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json \
  --production-deploy .tascverifier/production-deploy-handoff.json \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --production-capture .tascverifier/production-run-capture.json \
  --production-payout .tascverifier/production-payout-evidence.json \
  --task-account <task-account> \
  --vault-token-account <vault-token-account>

npm run real:readiness:plan
npm run real:readiness -- \
  --env .env.solana-mainnet.local \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json \
  --production-payout .tascverifier/production-payout-evidence.json
```

The shorter operator guide for repeating the controlled mainnet loop is [docs/production-mainnet-runbook.md](docs/production-mainnet-runbook.md).

`real:env:init` creates or updates the ignored `.env.solana-mainnet.local` file from `.env.example`, chmods it to `0600`, preserves existing values unless `--force` is used, can copy required values from the process environment with `--from-process-env`, can read the public program id from `.tascverifier/production-deploy-handoff.json`, derives standard buyer/worker USDC associated token accounts from public wallet + mint values when those token-account fields are blank, rejects private-key-like entries, and never prints the RPC URL.

`real:env:*` checks `.env.solana-mainnet.local` without printing the RPC URL, rejects private-key-like entries and devnet/test/local/example RPC hosts, and reports whether the mainnet values are ready for preflight. `real:pause` is the no-spend checkpoint: it reads only canonical production artifact paths, calls no RPC, writes nothing, prints no env values, rejects private-key-like env keys, and reports whether capture/payout evidence implies a mainnet spend already happened. `real:budget` is the no-spend budget gate: it reads an ignored `.tascverifier/production-budget-policy.json` if present, validates USD caps and explicitly allowed spend phases, calls no RPC, writes nothing, and does not prove readiness or completion. `real:resume` composes pause, budget, and env readiness into one read-only restart gate; it calls no RPC, writes nothing, sends nothing, and only reports whether spend work could resume after explicit operator unpause. `real:deploy:build` creates a sanitized mainnet deploy handoff from the SBF artifact and manifest, derives the public program id from the generated program keypair file, keeps the full RPC URL and key material out of JSON, and does not call RPC or send transactions. `real:intent:build` can read buyer, verifier, program, and token-mint values from env, then creates the unsigned mainnet buyer intent plus the exact canonical UTF-8 payload a wallet must sign. `real:intent:attach-signature` verifies the base58 Ed25519 wallet signature against the buyer address before writing the signed intent used by funding. `real:capture:*` records the public run evidence incrementally in `.tascverifier/production-run-capture.json` without private keys or transaction sends; init/payout can read stable public values and RPC from the env file, while `real:capture:record --transaction <artifact> --signature <sig>` validates the generated production transaction artifact and infers task/vault/destination/result fields before writing capture evidence. `real:submitter:serve` starts a localhost-only static server for `web/production-run.html` without reading env files or serving `.tascverifier/`; the page accepts only mainnet production token-account setup, fund, and lifecycle artifacts, requires the connected wallet to match the artifact signer, requires an explicit production-send checkbox, submits through the injected wallet provider, and prints either the matching capture command or the preflight rerun command from the returned signature. `real:local:*` provides a guarded dependencyless local signing path for operators who already have owner-private Solana keypair files; it verifies the keypair address matches the intent/artifact signer and does not print key material. `real:preflight` is a read-only mainnet safety gate. It verifies the RPC genesis hash, deployed program account, role SOL balances, verified USDC mint, buyer USDC balance, and worker USDC destination account without accepting private keys or printing the full RPC URL. `real:token-account:build` creates unsigned idempotent associated-token-account setup transactions for missing buyer/worker USDC ATAs, using read-only RPC only for blockhash/account checks and never accepting private keys, sending transactions, or persisting the full RPC URL. `real:fund:build` creates the unsigned buyer-wallet transaction that creates the task account, creates and initializes the PDA-owned vault token account, transfers exactly 10 USDC into that vault, and calls `global_tasc.fund`; it can read RPC and buyer USDC source account from env, can use read-only RPC for blockhash/rent/source-account checks, but never accepts private keys, sends transactions, or writes the full RPC URL. `real:lifecycle:build` creates unsigned role-wallet transactions for claim, verifier attest, worker release, and buyer timeout-refund from the signed mainnet intent and funded task account; it can read role signers, destination token accounts, and RPC from env, again without private keys, sends, or full RPC URL persistence. `real:payout:build` remains the lower-level direct artifact builder and can read stable public values/RPC from env. `real:packet:build` assembles the timed proof, deploy handoff, signed intent, capture file, fund and lifecycle transaction handoffs, browser submitter handoffs for `web/production-run.html`, payout evidence, redacted RPC host, live evidence checklist, and env-first remaining commands into `.tascverifier/production-run-packet.json`; it validates present artifacts but never calls RPC or sends transactions. `real:readiness` accepts the devnet timed proof as a prerequisite and can read RPC/genesis from env, but it refuses to mark the goal ready until the non-example mainnet USDC payout artifact proves funding, claim, attest, release, post-release balances, under-60-second timing, and live RPC verification. The live check verifies the RPC genesis hash, transaction confirmations, decoded released task account ownership/state, and SPL token-account balances without printing the full RPC URL. The schema example lives at `examples/private-beta/production-payout-evidence.example.json`.

## Why Tasc Might Work

Most micro-work systems fail on trust and timing. Workers do not want to wait for payment, and buyers do not want to pay before proof. Tasc narrows the problem:

- the buyer signs an exact task and funds escrow first
- the indexer publishes only signed-and-funded work
- the worker claims from a claimable feed, not a vague request list
- the verifier emits deterministic evidence
- the settlement layer releases or refunds according to task policy

The near-term product should not be "ask the world for $10." It should be "claim a pre-funded `$10` task and get paid as soon as verification passes."

## How To Help

The best first contributions are narrow and verifiable:

- harden live Solana `claim`, `attest`, `release`, and `refund`
- add dispute handling around release/refund eligibility
- harden duplicate-task, finality, and concurrency handling around the live Solana proofs
- publish fresh proof indexes as static feed artifacts with `npm run beta:feed`
- publish a fresh active claimable task feed with guarded `npm run beta:claimable`
- deploy the verifier API and feed its durable proof artifacts back into hosted task indexes
- live-test the guarded Solana operator console in wallet-extension browsers
- use `npm run beta:local` as the local operator session while testing Phantom/Solflare flows
- add more TascLang task examples with deterministic verifier rules
- build an indexer process that watches live Solana task accounts
- package the CLI so people can create and sign tasks without reading the internals
- write walkthroughs for buyers, workers, verifiers, and indexer operators

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then pick one of the tracks in [docs/adoption-plan.md](docs/adoption-plan.md).

## Safety And Status

- Do not use this for unsupervised public mainnet funds.
- Devnet keys and RPC URLs must stay local in `.env*` files.
- Live transaction commands are guarded by explicit environment flags.
- Current npm production dependency audit reports zero vulnerabilities.
- Runtime code avoids framework dependencies where practical.
- Licensed under Apache-2.0.
