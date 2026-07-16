# Progress Assessment

This repo is now a credible protocol prototype, not yet a product.

## Current Maturity

| Target | Estimated Progress | Notes |
| --- | ---: | --- |
| MVP mechanics | 100% | The protocol mechanics now cover signed funded inventory, worker claim before deadline, verifier pass/fail, release, failure refund, timeout refund after deadline while Funded/Claimed, custody scans, and completed settlement index admission. All of those paths are implemented, validated, SBF-built, and live-proven on Solana devnet. |
| Testnet MVP mechanics | 100% | Solana devnet now has finalized CPI-enabled program deploys, finalized token-backed fund transactions admitted with live vault custody, confirmed live claim/attest transactions, confirmed program-signed SPL release, failure-refund, and timeout-refund transactions, and completed-settlement evidence admitted as `completed` index entries. Product wallet flows are still outside protocol mechanics. |
| Private beta product | 50% | Protocol mechanics are live-proven, packaged behind a one-command devnet proof runner, and visible in a static browser operator console with feed import, Solana wallet connection, live task-account refresh, role detection, next-action readiness, and guarded wallet transaction construction/submission for claim, attest, release, refund, and timeout-refund. Missing live wallet QA, hosted fresh inventory, verifier service, reputation, disputes, and durable metadata. |
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
- The same static browser app can connect to an injected Solana wallet provider, refresh live Solana task accounts from RPC, decode the 276-byte task-account layout, classify the connected wallet role, and show the next valid protocol action.
- The static browser app can now build dependencyless Solana wallet transaction payloads for claim, attest, release, refund, and timeout-refund. The builder derives SPL destination token accounts and the vault-authority PDA in-browser, compiles a legacy Solana message with a fresh blockhash, and routes submission through an injected wallet provider behind an explicit send-enable toggle.
- The static browser app can import `tasc.index` JSON, raw `tasc.index.entry` arrays, and proof-summary objects whose referenced index files are hosted with the app. Completed entries replace older claimable entries for the same Solana task account.
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
- Timeout-aware Solana lifecycle builders now require Clock sysvar on claim and timeout-refund. Claim is only valid before deadline; timeout refund is valid after deadline from `Funded` or `Claimed` and routes funds back to the buyer token account.
- The lifecycle-enabled program redeploy confirmed at `3sg2FKp3GBxHt4Du1MCKfWaKvTUk9PGR4yTMo34Z4uZsLmyFpTVCAtkDwUNChXcNJs4T3pwhgUKtQreU9geGXpyu`; live claim confirmed at `3eQLPK2SsMFJySopM6W27YapKLAoxdFANy9qjf4JjoXe3suSt8yZLZrruFCTzBfqAkF4MvXPNieFQFasSoY4rBG6`; live verifier attest confirmed at `4ttsWrawCvg3v981Yyrsy8SYpr9ayzYmfLeVK72bvQmUBEHaaGyEiVCE9MLY3hYiTtR1ZZrS3NmMSsBnYA9sMUw1`, moving the live task account to `Passed`.
- The CPI-enabled program redeploy confirmed at `65J6aVdNgrmfqZAtCa2j6WCDUSUCypCHQuxgbnz1DDjK5vZJu1qXWwctsyYJiMZELWgNTb8FWqJVgxESbxBhucVf`; live release confirmed at `2dG66jTY9KTxzZhXFDLmiLcP6bM4mFEdtwb1FV28Zf3pNEr2Qxf4w7tc7P8E3NY4EWiLcCVX71B1nRaTVcPCEX3V`, moving the live task to `Released`, emptying vault token account `ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4`, and moving `10000000` token base units to worker token account `8KJmiwZR42u5pv5CKkxap6qFE1LYu4bKKye5DWXxbUJ8`.
- A reusable completed-settlement scanner now emits `tasc.settlement.solana.spl_token` evidence at `examples/solana-devnet/summarize_url_spl.settlement.live.json`, and the indexer admits it as `completed` at `examples/index/solana.spl.release.index.json` rather than re-admitting it as claimable inventory.
- A fresh failed-task refund proof confirmed on devnet: funding `5EjrMf1vZifxJCufdVJRgx9ZSBASLS4j7vejXQ8wtYdEwR9La9YYFECc8o5rEQZ2GnNs4TNN8KQfXwofJuEqgnuu`, claim `5bk9oGPPbC7wyEv1JyBAXwKcKrqii36hQNQBW8SfSWiFiG3FgEGiBtgNTLaviy3TWvywhZjCz2uuGNPHFLjzQPbP`, fail attest `7gS9gQXJhwUpqsW65Wu83wV13U8UxwPwQ3dgk5wVLApWtJEJknbCXtHp1egE6UsPRhEccYdCG2Jp4oo6TwfhVfP`, and refund `TmTDr1U2GKRdPQm1oq6CSDXs3nuuxiNyDFAY9wryjSdRQpgb8oBnghbYDzaEHH5V8GyAoPNsQxALevXxfKpcqxk`; the task account `CDK1cd9ghTj1Je8yXEVXZmDWJijJFQmctoNXKv9rqTZw` is `Refunded`, vault `9TmntNGZPy2Pnj3kiRM8CNdbaxiFMcV85s7V2cwLWZbB` is `0`, and buyer token account `3Vho8KJa6gfMMFi3LQk5EJPrComjZiHmCMb7BX7Scqxf` holds `10000000`.
- The completed-settlement scanner now validates both release and refund evidence; the refund evidence lives at `examples/solana-devnet/summarize_url_refund_job_spl.settlement.live.json` and admits as `completed` at `examples/index/solana.spl.refund.index.json`.
- The timeout-aware program deploy confirmed at `5sMn9YWpGjzFGYRTQtzZTMp5M1dm7z4nNLavUfFR17GRAQBxUyjFNAdRMTRi7kH9WBNECmXKtyxmWJMiz8ixmgLG`. A fresh overdue task then funded at `D6RG18ofYQSpJzaQPAJQHZW7XZBRe674YEYrjUETLYGnB1et8pHc3nWa855AdwxRfLuqUQcc9D9rW9jntuVL7fY` and timeout-refunded at `56eyY1wgLnS3TdScJ6ciVpVY8bDXMCCt6v3jZEYvbzcaAmENVeRYKPZ5ekC13vfR65BZvizzwdigNULqT1FD9iGa`, moving task account `F2jbuu49cAxc9eDC9jGrQ1TDq8Mb5Ei79UL3Lz6AR4v` from `Funded` to `Refunded`, emptying vault `Cx8EbkKKtK4babifUxkx45YVoze6aPxX6Q71T9a3VyUR`, and restoring `10000000` token base units to buyer token account `4G9eWtjdL8sbLL6gBb2ioABZrbkxxrcr7wQZAK8UGdmz` without worker claim or verifier failure.
- `npm run prove:solana-devnet:plan` provides a no-send proof plan, and `GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run prove:solana-devnet` packages a fresh live proof bundle for pass release, verifier-failed refund, and timeout refund under ignored `examples/solana-devnet/proofs/`.
- The current npm dependency tree has no production vulnerabilities, all 17 registry signatures verify, and 2 registry attestations verify.

## Biggest Missing Pieces

1. Verifier service: deterministic verifier runners, artifact storage, result attestations, and paid verifier incentives.
2. Reputation and abuse controls: worker/buyer/verifier histories, duplicate detection, bonds, rate limits, and spam economics.
3. Dispute path: reviewer selection, evidence packaging, deadlines, and appeal/ruling settlement.
4. Product surfaces: buyer task creation, hosted fresh inventory publishing, live wallet QA, notifications, and support tooling.
5. Decentralization: multiple indexers, gossip or replication, slashing/attestation rules, and censorship resistance.
6. Security hardening: contract tests, fuzzing, external audit, key management, dependency pinning policy, and incident response.
7. Reproducibility hardening: the guarded proof runner exists; remaining work is CI-safe replay, finality windows, and duplicate-task suppression around repeated public runs.

## Practical Distance

The fastest useful path is not full decentralization first. It is a narrow testnet marketplace loop:

```text
buyer signs and funds -> scanner batch -> index admission -> worker claims before deadline -> verifier attests -> escrow releases/refunds or buyer timeout-refunds after deadline
```

The happy-path, failed-task refund, and timeout-refund Solana testnet loops now work at protocol level. A production system that can safely support a global market for instant `$10` work is still much farther: likely months of focused buildout after dispute/product paths work, because the hard parts become abuse resistance, demand liquidity, dispute quality, and reliable user experience.

If Solana is the preferred path, the next increment is now concrete: live-test guarded browser wallet sends in a normal extension environment, then publish fresh proof indexes as a hosted feed instead of manually pasting artifacts.
