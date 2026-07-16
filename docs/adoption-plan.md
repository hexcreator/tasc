# Adoption Plan

The next goal is not broad hype. It is getting the right early people to run the proof, understand the boundary, and contribute to the missing loop.

## Who Should Use This First

| Audience | Why They Matter | First Ask |
| --- | --- | --- |
| Solana program builders | Finish live claim/attest/release safely. | Review lifecycle account transitions and SPL vault authority design. |
| Indexer/search builders | Turn signed-and-funded evidence into public inventory. | Run admission validators and propose account discovery. |
| Verification engineers | Make task completion objectively checkable. | Add verifier fixtures and artifact-hash flows. |
| Static web/product builders | Make the feed usable without hosted infra. | Improve `web/` into a public demo. |
| Task designers | Find useful `$10 / 60s` tasks that can be verified. | Submit new `.tasc` examples and verifier rules. |

## Public Launch Path

### 1. Make The Repo Trustworthy

Done:

- public repo exists
- secret ignore rules exist
- devnet SPL custody proof exists
- live claim/attest proof exists
- worker token account and release CPI plan artifacts exist
- validators exist
- Apache-2.0 license exists
- GitHub topics and starter issues exist
- guarded Solana wallet transaction construction exists in the static operator console
- static feed import exists for `tasc.index`, raw entry arrays, and hosted proof-summary indexes
- admitted feed entries carry signed task inputs, input hash, output schema, and verifier rules
- worker submissions can be captured as hashable proof JSON from the static web task card
- captured worker proofs can be ingested into `tasc.attestation` output with Solana-ready attest hashes
- verifier ingestion is exposed as a dependencyless HTTP API with bearer auth, durable artifacts, persistent duplicate ledger, health, and proof-ingest routes
- the static web flow can submit captured proof JSON to the verifier API and fill Solana attest controls from the response
- the wallet submission adapter is covered with mock `signAndSendTransaction` and `signTransaction` provider validation
- `npm run beta:local` starts a local private-beta operator session with the static app and verifier API on localhost, and the app auto-fills verifier URL/token from same-origin local config
- the static operator console exports redacted `tasc.private_beta.qa_evidence` bundles for private-beta wallet-extension runs

Next:

- live-test the guarded wallet send flow with Phantom or another injected Solana wallet using `npm run beta:local`, then export QA evidence; mock-provider coverage exists, but extension-prompt QA is still required
- deploy the verifier API and connect durable artifacts back into hosted feed/index publication
- publish a fresh proof index as a hosted feed artifact
- add a short demo video or GIF
- keep starter issues updated as protocol milestones land

### 2. Make The Proof Easy To Run

Target command:

```sh
npm install
npm run demo
```

Current supporting commands:

```sh
npm run compile:example
npm run verify:example
npm run demo:market
npm run validate:indexer
npm run validate:solana-spl-escrow
npm run validate:verifier-ingest
npm run validate:verifier-api
npm run validate:private-beta-local
npm run validate:solana-lifecycle-tx
npm run validate:solana-spl-settlement
```

Next:

- keep improving the `demo` script so it is the default first-run path
- use `beta:local` as the default operator session for wallet-extension QA
- keep improving the `devnet:proof` script so it reads existing public artifacts without sending transactions
- keep live sending commands behind guard env vars

### 3. Show A Real Claimable Feed

The current static web proof should become the main public demo:

- load `examples/index/solana.spl.live.index.json`
- import fresh proof/index artifacts without editing bundled demo code
- show task title, reward, 60-second window, signed input URL, output schema, verifier rules, status, chain, vault, and proof coordinates
- capture markdown output and derive the result hash the verifier will attest
- ingest captured proof JSON into `tasc.attestation` plus the Solana-ready result hash for `attest`
- call a local or deployed verifier API from the static web flow
- connect a Solana wallet and show live task-account status plus guarded role/action sends
- link to docs explaining what is real and what is simulated

### 4. Recruit The First Contributors

Open issues for:

- `good first issue`: create another `.tasc` task fixture
- `good first issue`: add README walkthrough screenshots
- `protocol`: implement program-signed SPL token release/refund CPI
- `indexer`: discover funded task accounts from program-owned accounts
- `indexer`: scan post-funding lifecycle state
- `web`: live-test wallet transaction submission in injected wallet browsers
- `verifier`: deploy the verifier API and publish durable ingestion artifacts into hosted indexes
- `security`: define pre-mainnet audit checklist

### 5. Get External Feedback

Share with a narrow audience first:

- Solana dev Discord builders
- Base/EVM escrow builders
- people building AI agent work marketplaces
- protocol engineers who care about verifiable off-chain work

Ask for specific feedback:

- Is the signed intent shape enough?
- Is the custody evidence convincing?
- Is the task language too narrow or too broad?
- What would make a worker trust a claimable task?
- What would make a buyer fund tasks before seeing a worker?

## Next Engineering Steps

1. Live-test guarded Solana wallet sends from the static operator console in a normal wallet-extension browser.
2. Deploy the verifier API and publish durable ingestion artifacts into hosted feed indexes.
3. Publish fresh proof indexes as hosted task-feed artifacts instead of only local runner output.
4. Add finality windows, duplicate-task suppression, and multi-RPC fallback to the browser/indexer boundary.
5. Start the dispute/reviewer path once pass/fail/timeout UX is usable end to end.

## Success Criteria For Early Use

Early users are actually using Tasc when:

- someone can run a local demo without reading internals
- someone can inspect the live devnet proof from README links
- someone can add a new task fixture and verifier rule
- someone can serve a static claimable feed
- a worker can see the exact signed input and verifier rules from the feed
- a worker can capture output and produce a verifier-compatible result hash
- a verifier can ingest the worker proof and produce an attestable `tasc.attestation`
- a verifier API can accept the same proof over HTTP and reject duplicates/tampering
- the static app can call that verifier API and prepare the corresponding Solana attest fields
- someone can connect a wallet and submit the correct guarded live role/action transaction
- a worker can complete a devnet task and see token release proof
