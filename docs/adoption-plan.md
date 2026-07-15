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
- validators exist
- Apache-2.0 license exists
- GitHub topics and starter issues exist

Next:

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
npm run validate:solana-lifecycle-tx
```

Next:

- keep improving the `demo` script so it is the default first-run path
- keep improving the `devnet:proof` script so it reads existing public artifacts without sending transactions
- keep live sending commands behind guard env vars

### 3. Show A Real Claimable Feed

The current static web proof should become the main public demo:

- load `examples/index/solana.spl.live.index.json`
- show task title, reward, deadline, status, chain, vault, and proof coordinates
- keep "claim" visibly disabled until wallet-backed live claim is exposed in the browser
- link to docs explaining what is real and what is simulated

### 4. Recruit The First Contributors

Open issues for:

- `good first issue`: create another `.tasc` task fixture
- `good first issue`: add README walkthrough screenshots
- `protocol`: implement program-signed SPL token release/refund CPI
- `indexer`: discover funded task accounts from program-owned accounts
- `indexer`: scan post-funding lifecycle state
- `web`: add wallet-backed claim controls once live claim is proven
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

1. Implement program-signed SPL token release/refund CPI.
2. Extend scanner/indexer from "funded" and "attested" to completed payout/refund state.
3. Add wallet-backed browser claim controls after release/refund semantics are safe.
4. Add one-command local demo.

## Success Criteria For Early Use

Early users are actually using Tasc when:

- someone can run a local demo without reading internals
- someone can inspect the live devnet proof from README links
- someone can add a new task fixture and verifier rule
- someone can serve a static claimable feed
- a worker can complete a devnet task and see token release proof
