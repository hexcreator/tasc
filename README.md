# Global Tasc

Global Tasc is a seed prototype for an instant micro-work market: buyers publish pre-funded tasks, workers claim and complete them, verifiers prove completion, and escrow settles in stablecoins.

The core design constraint is the original goal: make small amounts like `$10` earnable in less than a minute. That only becomes real when demand is already pre-funded or payment-authorized before work starts.

## V1 Thesis

Build a hybrid protocol:

- Off-chain task discovery, matching, indexing, and verifier execution.
- On-chain escrow for deposits, claims, releases, refunds, disputes, and reputation-impacting events.
- A constrained task language, `TascLang`, that compiles task contracts into canonical JSON, verifier config, and settlement policy.
- USDC as the first settlement asset.
- Base/EVM as the first full escrow target, with Solana now proving the faster-chain path through a live devnet program/fund/SPL-custody/scan/index loop.

## Repository Layout

- [docs/protocol-v1.md](/Users/chriscabral/Garage/global-tasc/docs/protocol-v1.md): protocol architecture and V1 choices.
- [docs/evm-settlement-v1.md](/Users/chriscabral/Garage/global-tasc/docs/evm-settlement-v1.md): first EVM escrow boundary.
- [docs/local-evm-v1.md](/Users/chriscabral/Garage/global-tasc/docs/local-evm-v1.md): local EVM token-settlement execution proof.
- [docs/base-sepolia-v1.md](/Users/chriscabral/Garage/global-tasc/docs/base-sepolia-v1.md): guarded public-testnet deployment/funding harness.
- [docs/solana-devnet-v1.md](/Users/chriscabral/Garage/global-tasc/docs/solana-devnet-v1.md): dependencyless Solana devnet harness and local settlement adapter.
- [docs/solana-program-v1.md](/Users/chriscabral/Garage/global-tasc/docs/solana-program-v1.md): Solana program-account ABI and scanner boundary.
- [docs/solana-deploy-v1.md](/Users/chriscabral/Garage/global-tasc/docs/solana-deploy-v1.md): Solana SBF artifact and deploy-readiness handoff.
- [docs/testnet-handoff-v1.md](/Users/chriscabral/Garage/global-tasc/docs/testnet-handoff-v1.md): public metadata bridge from testnet flow to scanner.
- [docs/task-intents-v1.md](/Users/chriscabral/Garage/global-tasc/docs/task-intents-v1.md): signed buyer intent boundary.
- [docs/wallet-signing-v1.md](/Users/chriscabral/Garage/global-tasc/docs/wallet-signing-v1.md): EIP-712 signing and recovery harness notes.
- [docs/funding-events-v1.md](/Users/chriscabral/Garage/global-tasc/docs/funding-events-v1.md): event-log-derived funding evidence.
- [docs/rpc-scanner-v1.md](/Users/chriscabral/Garage/global-tasc/docs/rpc-scanner-v1.md): persisted RPC log scanner for escrow funding events.
- [docs/static-web-v1.md](/Users/chriscabral/Garage/global-tasc/docs/static-web-v1.md): zero-fixed-cost static task feed.
- [docs/indexer-admission-v1.md](/Users/chriscabral/Garage/global-tasc/docs/indexer-admission-v1.md): signed-and-funded task admission rules.
- [docs/progress-assessment.md](/Users/chriscabral/Garage/global-tasc/docs/progress-assessment.md): current distance to MVP and production readiness.
- [examples/summarize_url.tasc](/Users/chriscabral/Garage/global-tasc/examples/summarize_url.tasc): first task-contract example.
- [examples/summarize_url_spl.tasc](/Users/chriscabral/Garage/global-tasc/examples/summarize_url_spl.tasc): fresh live-token-backed Solana task example.
- [examples/intents/summarize_url.intent.json](/Users/chriscabral/Garage/global-tasc/examples/intents/summarize_url.intent.json): deterministic example buyer intent.
- [examples/signatures/summarize_url.signature.json](/Users/chriscabral/Garage/global-tasc/examples/signatures/summarize_url.signature.json): deterministic example buyer signature.
- [examples/funding/summarize_url.funded.json](/Users/chriscabral/Garage/global-tasc/examples/funding/summarize_url.funded.json): deterministic funding evidence fixture.
- [examples/events/summarize_url.funded-log.json](/Users/chriscabral/Garage/global-tasc/examples/events/summarize_url.funded-log.json): deterministic escrow event log fixture.
- [examples/funding/summarize_url.from-log.json](/Users/chriscabral/Garage/global-tasc/examples/funding/summarize_url.from-log.json): funding evidence extracted from an escrow event log.
- [examples/scan/funded.batch.json](/Users/chriscabral/Garage/global-tasc/examples/scan/funded.batch.json): scanner output batch for confirmed funding logs.
- [examples/scan/funded.cursor.json](/Users/chriscabral/Garage/global-tasc/examples/scan/funded.cursor.json): persisted scanner cursor fixture.
- [examples/testnet/base-sepolia.handoff.example.json](/Users/chriscabral/Garage/global-tasc/examples/testnet/base-sepolia.handoff.example.json): testnet handoff fixture with public metadata only.
- [examples/index/summarize_url.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/summarize_url.index.json): generated claimable index fixture.
- [examples/index/funded.batch.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/funded.batch.index.json): generated claimable index from scanner batch admission.
- [examples/solana/summarize_url.intent.json](/Users/chriscabral/Garage/global-tasc/examples/solana/summarize_url.intent.json): deterministic Solana buyer intent fixture.
- [examples/solana/summarize_url.signature.json](/Users/chriscabral/Garage/global-tasc/examples/solana/summarize_url.signature.json): deterministic Solana Ed25519 signature fixture.
- [examples/solana/summarize_url.funding.json](/Users/chriscabral/Garage/global-tasc/examples/solana/summarize_url.funding.json): Solana funding evidence fixture.
- [examples/solana/summarize_url.settlement.json](/Users/chriscabral/Garage/global-tasc/examples/solana/summarize_url.settlement.json): local Solana account-model settlement result.
- [examples/solana/funded.batch.json](/Users/chriscabral/Garage/global-tasc/examples/solana/funded.batch.json): Solana funding batch fixture.
- [examples/index/solana.summarize_url.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/solana.summarize_url.index.json): Solana claimable index fixture.
- [examples/index/solana.funded.batch.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/solana.funded.batch.index.json): Solana claimable index from batch admission.
- [examples/solana-program/summarize_url.program-spec.json](/Users/chriscabral/Garage/global-tasc/examples/solana-program/summarize_url.program-spec.json): Solana task-account ABI fixture.
- [examples/solana-program/summarize_url.fund-instruction.json](/Users/chriscabral/Garage/global-tasc/examples/solana-program/summarize_url.fund-instruction.json): Solana fund instruction bytes fixture.
- [examples/solana-program/summarize_url.task-account.json](/Users/chriscabral/Garage/global-tasc/examples/solana-program/summarize_url.task-account.json): Solana task account fixture.
- [examples/solana-program/summarize_url.funding.from-account.json](/Users/chriscabral/Garage/global-tasc/examples/solana-program/summarize_url.funding.from-account.json): funding evidence decoded from the task account fixture.
- [examples/index/solana.program-account.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/solana.program-account.index.json): claimable index admitted from Solana program-account evidence.
- [examples/solana-devnet/summarize_url.intent.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url.intent.json): live devnet Solana buyer intent.
- [examples/solana-devnet/summarize_url.signature.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url.signature.json): live devnet Solana buyer signature.
- [examples/solana-devnet/summarize_url.task-account.live.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url.task-account.live.json): scanned live devnet Solana task account.
- [examples/solana-devnet/summarize_url.funding.live.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url.funding.live.json): funding evidence decoded from the live devnet task account.
- [examples/index/solana.live.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/solana.live.index.json): claimable index admitted from live Solana devnet evidence.
- [examples/solana-devnet/summarize_url_spl.intent.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url_spl.intent.json): live SPL-backed devnet Solana buyer intent.
- [examples/solana-devnet/summarize_url_spl.signature.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url_spl.signature.json): live SPL-backed devnet Solana buyer signature.
- [examples/solana-devnet/summarize_url_spl.fund-spl.live.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url_spl.fund-spl.live.json): guarded live SPL funding transaction result.
- [examples/solana-devnet/summarize_url_spl.task-account.live.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url_spl.task-account.live.json): scanned live SPL-backed task account.
- [examples/solana-devnet/summarize_url_spl.funding.live.json](/Users/chriscabral/Garage/global-tasc/examples/solana-devnet/summarize_url_spl.funding.live.json): funding evidence with live SPL vault custody.
- [examples/index/solana.spl.live.index.json](/Users/chriscabral/Garage/global-tasc/examples/index/solana.spl.live.index.json): claimable index admitted from live SPL custody-backed evidence.
- [web/index.html](/Users/chriscabral/Garage/global-tasc/web/index.html): dependencyless static browser feed for funded tasks.
- [contracts/TascEscrow.sol](/Users/chriscabral/Garage/global-tasc/contracts/TascEscrow.sol): dependency-free Solidity escrow surface.
- [contracts/MockUSDC.sol](/Users/chriscabral/Garage/global-tasc/contracts/MockUSDC.sol): local ERC-20 test token for escrow execution.
- [abi/TascEscrow.abi.json](/Users/chriscabral/Garage/global-tasc/abi/TascEscrow.abi.json): ABI for the escrow surface.
- [build/TascEscrow.json](/Users/chriscabral/Garage/global-tasc/build/TascEscrow.json): compiler artifact emitted by `solc-js`.
- [build/MockUSDC.json](/Users/chriscabral/Garage/global-tasc/build/MockUSDC.json): compiler artifact for the local test token.
- [bin/tasclang.js](/Users/chriscabral/Garage/global-tasc/bin/tasclang.js): dependencyless compiler seed.
- [bin/tascverify.js](/Users/chriscabral/Garage/global-tasc/bin/tascverify.js): local deterministic verifier seed.
- [bin/tascmarket.js](/Users/chriscabral/Garage/global-tasc/bin/tascmarket.js): local publish, claim, attest, release simulation.
- [bin/validate-evm.js](/Users/chriscabral/Garage/global-tasc/bin/validate-evm.js): dependencyless contract/ABI boundary validator.
- [bin/tascintent.js](/Users/chriscabral/Garage/global-tasc/bin/tascintent.js): dependencyless EIP-712 typed-data generator for buyer intents.
- [bin/validate-intent.js](/Users/chriscabral/Garage/global-tasc/bin/validate-intent.js): task-intent boundary validator.
- [bin/tascsign.js](/Users/chriscabral/Garage/global-tasc/bin/tascsign.js): EIP-712 signing and recovery CLI.
- [bin/validate-signature.js](/Users/chriscabral/Garage/global-tasc/bin/validate-signature.js): signature fixture validator.
- [bin/compile-solidity.js](/Users/chriscabral/Garage/global-tasc/bin/compile-solidity.js): solc-js compiler and ABI/artifact validator.
- [bin/run-local-escrow.js](/Users/chriscabral/Garage/global-tasc/bin/run-local-escrow.js): external local-RPC token-settlement execution flow.
- [bin/run-base-sepolia.js](/Users/chriscabral/Garage/global-tasc/bin/run-base-sepolia.js): env-based Base Sepolia mock funding harness.
- [bin/validate-base-sepolia.js](/Users/chriscabral/Garage/global-tasc/bin/validate-base-sepolia.js): offline guardrail validator for the Base Sepolia harness.
- [bin/run-solana-devnet.js](/Users/chriscabral/Garage/global-tasc/bin/run-solana-devnet.js): dependencyless Solana devnet wallet, airdrop, and balance harness.
- [bin/validate-solana-devnet.js](/Users/chriscabral/Garage/global-tasc/bin/validate-solana-devnet.js): offline Solana devnet harness validator.
- [bin/tascsolana.js](/Users/chriscabral/Garage/global-tasc/bin/tascsolana.js): dependencyless local Solana intent, funding, and settlement adapter.
- [bin/validate-solana-settlement.js](/Users/chriscabral/Garage/global-tasc/bin/validate-solana-settlement.js): Solana settlement adapter and index admission validator.
- [bin/tascsolana-program.js](/Users/chriscabral/Garage/global-tasc/bin/tascsolana-program.js): dependencyless Solana program-account ABI and scanner helper.
- [bin/validate-solana-program.js](/Users/chriscabral/Garage/global-tasc/bin/validate-solana-program.js): Solana program-account scanner/admission validator.
- [programs/solana-tasc/src/lib.rs](/Users/chriscabral/Garage/global-tasc/programs/solana-tasc/src/lib.rs): dependencyless Rust core for Solana task account and instruction bytes.
- [bin/validate-solana-source.js](/Users/chriscabral/Garage/global-tasc/bin/validate-solana-source.js): Rust source and ABI constant validator.
- [bin/solana-deploy-readiness.js](/Users/chriscabral/Garage/global-tasc/bin/solana-deploy-readiness.js): local Solana build/deploy toolchain gate.
- [bin/build-solana-sbf.js](/Users/chriscabral/Garage/global-tasc/bin/build-solana-sbf.js): guarded SBF artifact builder for the Solana fund processor.
- [bin/deploy-solana-program.js](/Users/chriscabral/Garage/global-tasc/bin/deploy-solana-program.js): guarded Solana devnet deploy planner and deploy command.
- [bin/create-solana-live-intent.js](/Users/chriscabral/Garage/global-tasc/bin/create-solana-live-intent.js): local devnet signed-intent writer using configured buyer/verifier addresses.
- [bin/run-solana-fund.js](/Users/chriscabral/Garage/global-tasc/bin/run-solana-fund.js): guarded Solana create-account-with-seed plus fund-instruction sender.
- [bin/tascsolana-spl.js](/Users/chriscabral/Garage/global-tasc/bin/tascsolana-spl.js): dependencyless SPL Token account and `TransferChecked` helper.
- [bin/run-solana-spl-setup.js](/Users/chriscabral/Garage/global-tasc/bin/run-solana-spl-setup.js): guarded devnet SPL mint/token-account setup sender.
- [bin/scan-solana-spl-live.js](/Users/chriscabral/Garage/global-tasc/bin/scan-solana-spl-live.js): read-only live SPL mint/token-account scanner.
- [bin/validate-solana-spl-escrow.js](/Users/chriscabral/Garage/global-tasc/bin/validate-solana-spl-escrow.js): offline SPL token custody boundary validator.
- [bin/scan-solana-live.js](/Users/chriscabral/Garage/global-tasc/bin/scan-solana-live.js): read-only live Solana task-account scanner.
- [bin/validate-testnet-handoff.js](/Users/chriscabral/Garage/global-tasc/bin/validate-testnet-handoff.js): offline testnet handoff validator.
- [bin/tascfunding.js](/Users/chriscabral/Garage/global-tasc/bin/tascfunding.js): escrow `Funded` log to funding evidence CLI.
- [bin/validate-funding.js](/Users/chriscabral/Garage/global-tasc/bin/validate-funding.js): funding event extraction validator.
- [bin/tascscan.js](/Users/chriscabral/Garage/global-tasc/bin/tascscan.js): read-only persisted scanner for escrow funding logs.
- [bin/validate-scanner.js](/Users/chriscabral/Garage/global-tasc/bin/validate-scanner.js): offline scanner cursor validator.
- [bin/validate-web.js](/Users/chriscabral/Garage/global-tasc/bin/validate-web.js): offline static web feed validator.
- [bin/tascindex.js](/Users/chriscabral/Garage/global-tasc/bin/tascindex.js): signed-funded task admission CLI.
- [bin/validate-indexer.js](/Users/chriscabral/Garage/global-tasc/bin/validate-indexer.js): index admission validator.
- [bin/validate-dependencies.js](/Users/chriscabral/Garage/global-tasc/bin/validate-dependencies.js): offline dependency policy validator.

## Try It

```sh
node bin/tasclang.js compile examples/summarize_url.tasc
npm run verify:example
npm run demo:market
npm run validate:evm
npm run intent:example
npm run validate:intent
npm run sign:example
npm run validate:signature
npm run compile:solidity
npm run local-escrow:plan
npm run base:plan
npm run validate:base-sepolia
npm run solana:plan
npm run solana:create-wallets
npm run solana:fund-roles
npm run validate:solana-devnet
npm run solana:demo-settlement
npm run validate:solana-settlement
npm run solana:program-plan
npm run solana:program-fixture
npm run solana:scan-program-fixture
npm run validate:solana-program
npm run validate:solana-source
npm run solana:deploy-readiness
npm run solana:build-sbf
npm run solana:deploy-plan
npm run solana:live-intent
npm run solana:fund-plan:live
npm run validate:solana-fund-tx
npm run validate:solana-spl-escrow
npm run solana:spl-setup-plan
npm run solana:spl-scan-plan
npm run solana:spl-scan-live
npm run solana:fund-spl-plan:live
npm run solana:scan-live-plan
npm run solana:scan-live
npm run index:admit-solana-live
npm run index:admit-solana-spl-live
npm run validate:solana-live-scan
npm run validate:testnet-handoff
npm run funding:fixture-log
npm run funding:extract
npm run validate:funding
npm run scan:plan
npm run validate:scanner
npm run validate:web
npm run index:admit
npm run index:admit-batch
npm run index:admit-solana
npm run index:admit-solana-batch
npm run index:admit-solana-program
npm run index:reject-bad
npm run validate:indexer
npm run validate:dependencies
```

The compiler emits canonical task JSON and a SHA-256 hash. That hash is the object a buyer signs and funds, a worker claims, and a verifier references during payout.

The verifier emits an attestation-shaped JSON object with a verdict, per-rule checks, the task hash, and the result hash.

The market demo simulates the minimum useful loop:

```text
funded -> claimed -> passed -> released
```

That is the local version of the eventual on-chain escrow path.

The funding demo derives funding evidence from an escrow event log, rejects reorged or under-confirmed logs, and feeds the resulting evidence into indexer admission.

The scanner demo reads confirmed `Funded` logs, writes a restartable cursor, and produces a funding batch for index admission.

The static web demo opens from [web/index.html](/Users/chriscabral/Garage/global-tasc/web/index.html), imports public handoff metadata, scans `Funded` events directly from RPC, and caches the task feed in the browser.

The indexer demo admits a task only when the buyer signature and extracted funding evidence agree on chain, escrow, buyer, token, amount, deadline, and task hash. It can admit a single funding evidence object or a scanner batch against a local signed intent catalog. Its output is the worker-facing claimable inventory record.

The Solana settlement demo signs a Solana-style buyer intent, derives task/vault addresses, simulates `funded -> claimed -> passed -> released`, emits `tasc.funding.solana`, and admits it through the same indexer boundary. That demo remains local; the separate devnet path now deploys the fund-account processor and admits live scanned task-account evidence.

The Solana program-account demo defines the fixed task account layout and fund instruction bytes a real Solana program should implement. It decodes a funded task account into `tasc.funding.solana` and admits that evidence as claimable inventory.

The Solana source validator compiles and tests a no-dependency Rust core crate for the same account/instruction bytes. `npm run solana:build-sbf` emits a guarded SBF artifact with an `entrypoint` symbol and a minimal fund processor that writes the live task account bytes. The current artifact is deployed on devnet, a guarded fund transaction finalized, and the read-only live scanner admits that task as claimable inventory. The SPL path now creates a live devnet mint, transfers test tokens into a fresh PDA-owned task vault, scans the vault custody, and admits the token-backed task as claimable inventory.

## Non-Goals

- No new L1 in V1.
- No fully on-chain marketplace orderbook in V1.
- No general-purpose smart contract language.
- No unfunded global donation requests.

The first useful product is not "ask the world for $10." It is "claim a pre-funded $10 task globally and settle instantly when proof passes."
