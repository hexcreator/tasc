# Progress Assessment

This repo is now a credible protocol prototype, not yet a product.

## Current Maturity

| Target | Estimated Progress | Notes |
| --- | ---: | --- |
| Technical protocol skeleton | 99% | Hashable task language, verifier, signed intents, escrow ABI/contract, event-derived funding, admission gate, scanner cursor, testnet handoff, static web discovery proof, scanner-batch index admission, Solana devnet substrate, local Solana adapter, Solana account ABI, dependencyless Rust source core, SBF fund/lifecycle/CPI processor, guarded Solana fund/lifecycle transaction builders, live devnet deploy/fund/claim/attest/release proof, live account scanner, SPL custody boundary, live SPL setup scanner, and live SPL token-backed funding proof exist. |
| Testnet MVP | 93% | Base Sepolia is blocked by faucet friction; Solana devnet now has a finalized CPI-enabled program deploy, finalized token-backed fund transaction admitted with live vault custody, confirmed live claim/attest transactions, a confirmed program-signed SPL release from vault to worker token account, and completed-settlement evidence admitted as a `completed` index entry. Remaining testnet gaps are fresh-task refund exercise, timeout/dispute policy, and product wallet flows. |
| Private beta product | 25% | Missing buyer/worker wallet flows, real task inventory, verifier service, reputation, disputes, and durable metadata. |
| Production decentralized marketplace | 10% | Missing decentralization, economic security, audits, abuse controls, governance, and real liquidity/demand. |

## What Is Proven

- A task can be compiled to canonical JSON and a stable hash.
- A buyer intent can bind that task hash to chain, escrow, token, amount, deadline, verifier, and nonce.
- A buyer signature can be recovered and checked.
- Escrow contract artifacts compile and map the lifecycle to ERC-20 settlement.
- A `Funded` event can be decoded into funding evidence.
- Funding evidence can be matched against the signed intent before indexing.
- A scanner can read confirmed `Funded` logs, persist a cursor, and avoid duplicate scans.
- The Base Sepolia flow can emit a public handoff manifest that derives scanner environment without storing private keys.
- A static browser app can decode `Funded` logs directly from RPC with no backend, no database, and no runtime dependencies.
- A scanner funding batch can be admitted against a signed intent catalog and written as a claimable task index with explicit rejected entries.
- Solana devnet keys can be generated locally without dependencies, the harness can request airdrops/read balances through raw JSON-RPC, and one funded devnet wallet can transfer SOL to the other roles with a locally signed System Program transfer.
- A Solana-style buyer intent can be signed and verified with Ed25519, mapped to task/vault addresses, simulated through `funded -> claimed -> passed -> released`, emitted as `tasc.funding.solana`, and admitted into the same indexer boundary as EVM funding.
- A Solana task-account ABI can encode a funded task into a 276-byte account, round-trip a 121-byte fund instruction, scan that account into `tasc.funding.solana`, reject released or mismatched accounts, and admit the evidence as claimable inventory.
- A dependencyless Rust core crate now compiles/tests the same task-account layout, fund instruction, and claim/attest/release/refund state transitions.
- A guarded SBF build emits `build/solana/global_tasc_solana_program.so`, records its SHA-256 manifest, exposes the Solana `entrypoint` symbol, parses runtime input, and writes the funded task account without adding npm or Cargo dependencies.
- A guarded Solana transaction sender can create deterministic task/vault accounts with `create_account_with_seed`, then call the Global Tasc fund instruction. A live devnet signed intent now matches the local buyer and generated program id.
- The Solana program was deployed to devnet at `FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM`; the deploy transaction `4veC8ijRVhzgCcUU6DKXmB7RoF7YRZmtRxz5Esxfm9kzdAzuAPr3cHATe6gNjp1YyVD7JaVqmhSF1GPps5fvBqMg` finalized.
- A guarded live fund transaction finalized at `BH2QJ4iWHFp9W6Tk4a27v5osyySBdhdcuswePAWjqTqXes26rVY1QeszcXhbnV6uyL4aH8fg12kfozGby2Swfqp`, creating a `Funded` task account at `55mDcsddNiSvUKfrrRBbmP7mPeuT9UDf4kRL8EygvDEa`.
- A read-only Solana live scanner can fetch that deterministic task account, decode it into `tasc.funding.solana`, preserve the actual funding transaction signature, and admit the result through the existing indexer boundary.
- A dependencyless SPL Token helper can encode `TransferChecked`, decode 165-byte token accounts, produce vault custody evidence, and make the indexer reject underfunded Solana custody proofs.
- A guarded SPL setup transaction finalized on devnet at `2p6vSHtZDa6FM48jwA1Ck4EQb1hTaE2b7eNf1YDB159HdkMoE9ZN59kXeLCboxvazaqW1Wh2Z5KVjS6UrVXr8DE3`, creating mint `8WdRRCNVr8Du5Q1C1EeiMvqCRpSTBwWnHRjnx3FZ7KbC`, buyer token account `532DEeJ1PHjgd56Tzk86G5zFavXVwj4NBVHRrQaoUf6E`, and PDA-owned vault token account `5pzDYJ55KMtFC5aH6uQSmRpBBBTyuENLCLsb2Ng9fexc`.
- A read-only SPL scanner decodes the live mint supply as `10000000`, token account owners, and current balances. After the token-backed funding transaction, the original buyer token account is `0`, the original setup vault is `0`, and the fresh funded task vault holds `10000000`.
- A guarded live SPL funding transaction confirmed at `zhrqMMYfXQAK37hLVkuvmqNwb2VzkdM4ZyHZMhpBhci97j3L38A7dswKhA9PsjimMPEFczf9NoWu5pR4jnudsm1`, creating funded task account `37hA4KUeR6eLPP1g1mBoTMYHKCPq7LECpLryQc61TmRi`, transferring `10000000` token base units into vault token account `ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4`, scanning that custody, and admitting it as claimable at `examples/index/solana.spl.live.index.json`.
- Guarded Solana lifecycle transaction builders now emit dependencyless claim, attest, release, and refund instructions. Release/refund include the SPL vault, mint, destination token account, vault authority PDA, and token program so the on-chain program can sign `TransferChecked` from the PDA-owned vault.
- The lifecycle-enabled program redeploy confirmed at `3sg2FKp3GBxHt4Du1MCKfWaKvTUk9PGR4yTMo34Z4uZsLmyFpTVCAtkDwUNChXcNJs4T3pwhgUKtQreU9geGXpyu`; live claim confirmed at `3eQLPK2SsMFJySopM6W27YapKLAoxdFANy9qjf4JjoXe3suSt8yZLZrruFCTzBfqAkF4MvXPNieFQFasSoY4rBG6`; live verifier attest confirmed at `4ttsWrawCvg3v981Yyrsy8SYpr9ayzYmfLeVK72bvQmUBEHaaGyEiVCE9MLY3hYiTtR1ZZrS3NmMSsBnYA9sMUw1`, moving the live task account to `Passed`.
- The CPI-enabled program redeploy confirmed at `65J6aVdNgrmfqZAtCa2j6WCDUSUCypCHQuxgbnz1DDjK5vZJu1qXWwctsyYJiMZELWgNTb8FWqJVgxESbxBhucVf`; live release confirmed at `2dG66jTY9KTxzZhXFDLmiLcP6bM4mFEdtwb1FV28Zf3pNEr2Qxf4w7tc7P8E3NY4EWiLcCVX71B1nRaTVcPCEX3V`, moving the live task to `Released`, emptying vault token account `ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4`, and moving `10000000` token base units to worker token account `8KJmiwZR42u5pv5CKkxap6qFE1LYu4bKKye5DWXxbUJ8`.
- A reusable completed-settlement scanner now emits `tasc.settlement.solana.spl_token` evidence at `examples/solana-devnet/summarize_url_spl.settlement.live.json`, and the indexer admits it as `completed` at `examples/index/solana.spl.release.index.json` rather than re-admitting it as claimable inventory.
- The current npm dependency tree has no production vulnerabilities, all 17 registry signatures verify, and 2 registry attestations verify.

## Biggest Missing Pieces

1. Refund and timeout path: fresh-task refund exercise, lock expiry, and concurrency tests.
2. Verifier service: deterministic verifier runners, artifact storage, result attestations, and paid verifier incentives.
3. Reputation and abuse controls: worker/buyer/verifier histories, duplicate detection, bonds, rate limits, and spam economics.
4. Dispute path: reviewer selection, evidence packaging, deadlines, and appeal/ruling settlement.
5. Product surfaces: buyer task creation, worker claim UI, wallet flows, notifications, and support tooling.
6. Decentralization: multiple indexers, gossip or replication, slashing/attestation rules, and censorship resistance.
7. Security hardening: contract tests, fuzzing, external audit, key management, dependency pinning policy, and incident response.

## Practical Distance

The fastest useful path is not full decentralization first. It is a narrow testnet marketplace loop:

```text
buyer signs and funds -> scanner batch -> index admission -> worker claims -> verifier attests -> escrow releases
```

The happy-path Solana testnet loop now works at protocol level. A production system that can safely support a global market for instant `$10` work is still much farther: likely months of focused buildout after refund/dispute paths work, because the hard parts become abuse resistance, demand liquidity, dispute quality, and reliable user experience.

If Solana is the preferred path, the next increment is now concrete: exercise refund on a fresh failed task, then add timeout policy around refund eligibility.
