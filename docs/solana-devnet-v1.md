# Solana Devnet V1

This spike checks whether Solana devnet removes the faucet friction that blocked the Base Sepolia proof, then adds a local Solana settlement adapter that preserves the Global Tasc lifecycle.

It does not replace the EVM escrow yet. It proves the first Solana substrate pieces:

- dependencyless Solana key generation
- devnet account funding through raw JSON-RPC
- balance reads through raw JSON-RPC
- a concrete local settlement adapter
- a fixed Solana task-account ABI and scanner evidence boundary
- a live devnet program/fund/scan/index proof

## Why Solana

Solana is attractive for Global Tasc because:

- transactions are fast
- fees are tiny
- devnet supports RPC airdrops
- the user-facing mental model is closer to instant micro-work

The tradeoff is that Solana escrow is a different implementation. The current repo has a working Solidity escrow and EVM log indexer; Solana needs a program, account model, and scanner adapter.

## Commands

Show local Solana devnet setup:

```sh
npm run solana:plan
```

Create fresh devnet-only keypairs:

```sh
npm run solana:create-wallets
```

This writes:

```text
.env.solana-devnet.local
```

The file is chmod `0600` and ignored by git. It stores Solana CLI-compatible 64-byte keypair arrays. Do not use these keys for real funds.

Request devnet SOL:

```sh
npm run solana:airdrop:buyer
```

Or fund all three test roles:

```sh
npm run solana:airdrop:all
```

If only one faucet drip succeeds, fund the remaining local roles from the buyer:

```sh
npm run solana:fund-roles
```

This signs plain Solana System Program transfers locally with the buyer devnet key and sends them through JSON-RPC. No Solana SDK is required.

Check balances:

```sh
npm run solana:balances
```

Validate offline behavior:

```sh
npm run validate:solana-devnet
```

Generate a local Solana settlement fixture:

```sh
npm run solana:demo-settlement
```

This writes:

```text
examples/solana/summarize_url.intent.json
examples/solana/summarize_url.signature.json
examples/solana/summarize_url.funding.json
examples/solana/summarize_url.settlement.json
examples/solana/funded.batch.json
```

Admit the Solana funding evidence through the shared indexer boundary:

```sh
npm run index:admit-solana
npm run index:admit-solana-batch
```

Validate the full local adapter:

```sh
npm run validate:solana-settlement
```

Generate the Solana program-account ABI fixture:

```sh
npm run solana:program-plan
npm run solana:program-fixture
```

Scan the task-account fixture into funding evidence and admit it:

```sh
npm run solana:scan-program-fixture
npm run index:admit-solana-program
```

Validate the program-account scanner boundary:

```sh
npm run validate:solana-program
```

Validate the Rust source core and deploy readiness:

```sh
npm run validate:solana-source
npm run validate:solana-spl-settlement
npm run solana:deploy-readiness
npm run solana:build-sbf
npm run solana:live-intent
npm run solana:fund-plan:live
npm run validate:solana-spl-escrow
npm run solana:spl-setup-plan
npm run solana:spl-scan-plan
npm run solana:scan-live-plan
```

Run the guarded live sequence only when spending devnet SOL is intended:

```sh
GLOBAL_TASC_ALLOW_SOLANA_DEPLOY=1 npm run solana:deploy
GLOBAL_TASC_ALLOW_SOLANA_FUND=1 npm run solana:fund-send:live
npm run solana:scan-live
npm run index:admit-solana-live
```

Run the guarded SPL test-token setup only when spending devnet SOL is intended:

```sh
GLOBAL_TASC_ALLOW_SOLANA_SPL_SETUP=1 npm run solana:spl-setup-send
npm run solana:spl-scan-live
```

Create and plan a fresh token-backed task using the live SPL mint:

```sh
node bin/create-solana-live-intent.js examples/summarize_url_spl.tasc --token-mint 8WdRRCNVr8Du5Q1C1EeiMvqCRpSTBwWnHRjnx3FZ7KbC
npm run solana:fund-spl-plan:live
```

Run the guarded token-backed funding transaction only when spending devnet SOL and moving the test tokens is intended:

```sh
GLOBAL_TASC_ALLOW_SOLANA_SPL_FUND=1 npm run solana:fund-spl-send:live
```

Then scan the fresh task account and vault token account with the returned transaction signature:

```sh
node bin/scan-solana-live.js scan examples/solana-devnet/summarize_url_spl.signature.json \
  --account-out examples/solana-devnet/summarize_url_spl.task-account.live.json \
  --out examples/solana-devnet/summarize_url_spl.funding.live.json \
  --signature zhrqMMYfXQAK37hLVkuvmqNwb2VzkdM4ZyHZMhpBhci97j3L38A7dswKhA9PsjimMPEFczf9NoWu5pR4jnudsm1 \
  --instruction-index 4 \
  --confirmation-status confirmed \
  --custody-account ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4 \
  --custody-instruction-index 3 \
  --custody-decimals 6
npm run index:admit-solana-spl-live
```

## Current Feasibility Result

Public `https://api.devnet.solana.com` balance reads work, but public `requestAirdrop` can rate-limit. An Alchemy Solana Devnet RPC app works for reads and successfully funded the buyer wallet with devnet SOL. If repeated faucet calls fail, one successful buyer airdrop is enough because the harness can transfer devnet SOL from buyer to worker and verifier.

Current funded devnet roles:

```text
buyer:    6Apg3YonZ8yCnhSnEVPx3EoUZYnhH9297EuCf5A1beTR
worker:   BfRmLmH7ksPRCRxNBi7c8SspN7zKoyuAPKrJMDL5uQCJ
verifier: 3Siw3mYu8yQVaZ8qvXH5z4quyhhk6vBySn5d3KhNW9Tt
```

Observed balances before the live SPL funding transaction:

```text
buyer:    0.024071 SOL
worker:   0.01 SOL
verifier: 0.01 SOL
```

## Settlement Adapter Shape

The minimal Solana path preserves the existing Global Tasc lifecycle:

```text
funded -> claimed -> passed/failed -> released/refunded/disputed
```

The local adapter currently models:

- a Solana buyer intent: `tasc.intent.solana`
- a Solana Ed25519 buyer signature: `tasc.intent.signature.solana`
- a task PDA derived from `program_id` and `task_hash`
- a vault address derived from `program_id`, `task_hash`, and `token_mint`
- a funding proof object: `tasc.funding.solana`
- buyer, worker, verifier, amount, deadline, and status fields
- local `fund`, `claim`, `attest`, `release`, failure refund, and timeout refund state transitions

The live program processor now accepts the same lifecycle instruction tags for task-account status transitions:

```text
claim:   worker signer + writable task account + Clock sysvar -> Claimed before deadline
attest:  verifier signer + writable task account -> Passed/Failed
release: worker signer + writable task account + SPL settlement accounts -> TransferChecked + Released after Passed
refund:  buyer signer + writable task account + SPL settlement accounts -> TransferChecked + Refunded after Failed
refund:  buyer signer + writable task account + SPL settlement accounts + Clock sysvar -> Refunded after timeout while Funded/Claimed
```

The guarded CLI builder for those transactions is `bin/run-solana-lifecycle.js`. `release`, failure `refund`, and `timeout-refund` pass the vault token account, mint, destination token account, vault authority PDA, and SPL Token Program account so the on-chain program can sign an SPL Token `TransferChecked` CPI from the vault authority PDA. `claim` and `timeout-refund` pass the Clock sysvar for deadline enforcement.

The SPL settlement prep CLI is `bin/run-solana-spl-settlement.js`:

```sh
npm run solana:spl-worker-token-plan
GLOBAL_TASC_ALLOW_SOLANA_WORKER_TOKEN_SETUP=1 npm run solana:spl-worker-token-send
npm run solana:spl-release-plan
npm run solana:spl-timeout-refund-plan -- examples/solana-devnet/<overdue>.signature.json --task-account examples/solana-devnet/<overdue>.task-account.live.json --funding examples/solana-devnet/<overdue>.funding.live.json
npm run validate:solana-spl-settlement
```

`plan-release` is read-only. It validates the signed intent, live task account, funding evidence, vault authority PDA, and worker token account before emitting the exact `spl_token.transfer_checked` CPI account shape. `plan-refund` uses the same shape for failed tasks. `plan-timeout-refund` accepts `Funded` or `Claimed` tasks only when `now >= deadline_unix`, and the guarded sender is `GLOBAL_TASC_ALLOW_SOLANA_TIMEOUT_REFUND=1 npm run solana:lifecycle-timeout-refund-send`.

The TascLang source should stay chain-agnostic. It should compile to the same canonical task hash and then generate Solana-specific settlement bindings separately.

The adapter is intentionally dependencyless. It uses Node built-ins for Ed25519 signing/verification and reuses the local base58 implementation from the devnet harness instead of adding `@solana/web3.js`.

The original local adapter is now backed by a deployed devnet fund-account processor. The placeholder fund proof created account state only; the SPL path now also moves live test tokens into a fresh task vault with `TransferChecked`, scans that vault token account, and admits only custody-backed funding evidence.

## Program Account ABI

The program processor in [docs/solana-program-v1.md](/Users/chriscabral/Garage/global-tasc/docs/solana-program-v1.md) defines the fixed task-account layout and fund instruction bytes.

Current fixture facts:

```text
task account size: 276 bytes
fund instruction size: 121 bytes
attest instruction size: 34 bytes
funded status code: 1
scanner output: tasc.funding.solana
```

This moved the Solana path from "local settlement simulation" to a scanner-ready live account contract.

The Rust source core now exists under `programs/solana-tasc/` and validates the same account and instruction bytes without external Cargo dependencies. The Solana CLI and SBF toolchain are installed on this machine, and the current artifact has been deployed to devnet.

Current live account-state proof:

```text
program id:   FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM
deploy tx:    4veC8ijRVhzgCcUU6DKXmB7RoF7YRZmtRxz5Esxfm9kzdAzuAPr3cHATe6gNjp1YyVD7JaVqmhSF1GPps5fvBqMg
fund tx:      BH2QJ4iWHFp9W6Tk4a27v5osyySBdhdcuswePAWjqTqXes26rVY1QeszcXhbnV6uyL4aH8fg12kfozGby2Swfqp
task account: 55mDcsddNiSvUKfrrRBbmP7mPeuT9UDf4kRL8EygvDEa
index output: examples/index/solana.live.index.json
```

Current live SPL setup proof:

```text
setup tx:             2p6vSHtZDa6FM48jwA1Ck4EQb1hTaE2b7eNf1YDB159HdkMoE9ZN59kXeLCboxvazaqW1Wh2Z5KVjS6UrVXr8DE3
mint:                 8WdRRCNVr8Du5Q1C1EeiMvqCRpSTBwWnHRjnx3FZ7KbC
buyer token account:  532DEeJ1PHjgd56Tzk86G5zFavXVwj4NBVHRrQaoUf6E
vault token account:  5pzDYJ55KMtFC5aH6uQSmRpBBBTyuENLCLsb2Ng9fexc
vault authority PDA:  Hb7UnP6kkDHUpRZARHQGdnat1vHmsEEyrGF2XjBmg8EQ
scan output:          examples/solana-devnet/spl-accounts.live.json
```

After the live token-backed funding transaction, the setup scan is no longer an initial distribution proof: the buyer token account is `0`, the original setup vault remains `0`, and `initial_balances_match_setup` is `false`. The funded task vault is the fresh vault token account in the next block.

Current live SPL token-backed funding proof:

```text
fund tx:              zhrqMMYfXQAK37hLVkuvmqNwb2VzkdM4ZyHZMhpBhci97j3L38A7dswKhA9PsjimMPEFczf9NoWu5pR4jnudsm1
task account:         37hA4KUeR6eLPP1g1mBoTMYHKCPq7LECpLryQc61TmRi
vault token account:  ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4
vault authority PDA:  8ysLbdWSpBQCPV5De2GWonQWM5cCjNw93d44ihh2Hv9F
token mint:           8WdRRCNVr8Du5Q1C1EeiMvqCRpSTBwWnHRjnx3FZ7KbC
amount:               10000000 base units
task scan output:     examples/solana-devnet/summarize_url_spl.task-account.live.json
funding evidence:     examples/solana-devnet/summarize_url_spl.funding.live.json
index output:         examples/index/solana.spl.live.index.json
```

Current live lifecycle proof:

```text
lifecycle deploy tx:  3sg2FKp3GBxHt4Du1MCKfWaKvTUk9PGR4yTMo34Z4uZsLmyFpTVCAtkDwUNChXcNJs4T3pwhgUKtQreU9geGXpyu
claim tx:             3eQLPK2SsMFJySopM6W27YapKLAoxdFANy9qjf4JjoXe3suSt8yZLZrruFCTzBfqAkF4MvXPNieFQFasSoY4rBG6
attest tx:            4ttsWrawCvg3v981Yyrsy8SYpr9ayzYmfLeVK72bvQmUBEHaaGyEiVCE9MLY3hYiTtR1ZZrS3NmMSsBnYA9sMUw1
task account:         37hA4KUeR6eLPP1g1mBoTMYHKCPq7LECpLryQc61TmRi
current status:       Passed
worker:               BfRmLmH7ksPRCRxNBi7c8SspN7zKoyuAPKrJMDL5uQCJ
result hash:          0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f
lifecycle deploy out: examples/solana-devnet/summarize_url_spl.lifecycle-deploy.live.json
lifecycle scan output: examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json
```

Current live SPL settlement-prep proof:

```text
worker token setup tx: 2n64u7tNKnazWoaSjxW54fWhRqxk2PJrhrf2kuA47yMBXtUdR9m1WHmQmhpzLaqxn59Kr53FMrPzsH7NCj5c8VUu
worker token account: 8KJmiwZR42u5pv5CKkxap6qFE1LYu4bKKye5DWXxbUJ8
release source vault:  ChfKa5tEUjeSdaEhmjiDCWQE1Q6YT1oVaZt62HHR43b4
release destination:   8KJmiwZR42u5pv5CKkxap6qFE1LYu4bKKye5DWXxbUJ8
vault authority PDA:   8ysLbdWSpBQCPV5De2GWonQWM5cCjNw93d44ihh2Hv9F
release data:          0x0c809698000000000006
worker token output:   examples/solana-devnet/summarize_url_spl.worker-token.live.json
release plan output:   examples/solana-devnet/summarize_url_spl.release-plan.live.json
```

Current live SPL release proof:

```text
cpi deploy tx:        65J6aVdNgrmfqZAtCa2j6WCDUSUCypCHQuxgbnz1DDjK5vZJu1qXWwctsyYJiMZELWgNTb8FWqJVgxESbxBhucVf
release tx:           2dG66jTY9KTxzZhXFDLmiLcP6bM4mFEdtwb1FV28Zf3pNEr2Qxf4w7tc7P8E3NY4EWiLcCVX71B1nRaTVcPCEX3V
task account:         37hA4KUeR6eLPP1g1mBoTMYHKCPq7LECpLryQc61TmRi
post-release status:  Released
vault token balance:  0
worker token balance: 10000000
release output:       examples/solana-devnet/summarize_url_spl.release.live.json
release scan output:  examples/solana-devnet/summarize_url_spl.release-scan.live.json
settlement evidence:  examples/solana-devnet/summarize_url_spl.settlement.live.json
settlement index:     examples/index/solana.spl.release.index.json
```

Current live SPL refund proof:

```text
setup tx:             bt81DL9JTfChfsNJhA8eWq4iZsmWxr6HEt1UM6dFn3aK93ARc2GgsKfjV1sg7sQFMFVgBij8KhzRsMEEMaoTFE9
fund tx:              5EjrMf1vZifxJCufdVJRgx9ZSBASLS4j7vejXQ8wtYdEwR9La9YYFECc8o5rEQZ2GnNs4TNN8KQfXwofJuEqgnuu
claim tx:             5bk9oGPPbC7wyEv1JyBAXwKcKrqii36hQNQBW8SfSWiFiG3FgEGiBtgNTLaviy3TWvywhZjCz2uuGNPHFLjzQPbP
fail attest tx:       7gS9gQXJhwUpqsW65Wu83wV13U8UxwPwQ3dgk5wVLApWtJEJknbCXtHp1egE6UsPRhEccYdCG2Jp4oo6TwfhVfP
refund tx:            TmTDr1U2GKRdPQm1oq6CSDXs3nuuxiNyDFAY9wryjSdRQpgb8oBnghbYDzaEHH5V8GyAoPNsQxALevXxfKpcqxk
task account:         CDK1cd9ghTj1Je8yXEVXZmDWJijJFQmctoNXKv9rqTZw
post-refund status:   Refunded
vault token balance:  0
buyer token balance:  10000000
mint:                 3WkGDdNk6FuipY2Vsf7gKK93ehCHpqCEWPJ4wDwN3y1o
refund vault:         9TmntNGZPy2Pnj3kiRM8CNdbaxiFMcV85s7V2cwLWZbB
buyer token account:  3Vho8KJa6gfMMFi3LQk5EJPrComjZiHmCMb7BX7Scqxf
funding evidence:     examples/solana-devnet/summarize_url_refund_job_spl.funding.live.json
lifecycle scan output: examples/solana-devnet/summarize_url_refund_job_spl.lifecycle-account.live.json
settlement evidence:  examples/solana-devnet/summarize_url_refund_job_spl.settlement.live.json
settlement index:     examples/index/solana.spl.refund.index.json
```

The refund proof uses two task hashes on purpose. `summarize_url_refund.tasc` creates a fresh SPL mint and buyer token setup; `summarize_url_refund_job.tasc` is the actual funded task, so its deterministic vault account is fresh when funding runs.

Current live SPL timeout-refund proof:

```text
timeout deploy tx:       5sMn9YWpGjzFGYRTQtzZTMp5M1dm7z4nNLavUfFR17GRAQBxUyjFNAdRMTRi7kH9WBNECmXKtyxmWJMiz8ixmgLG
setup tx:                4uR2z2BPZwa1y5YmowbKuVoNUbdsRXtJBJBo6v4QxKGbh1YQAf2fCu91kpLbghY9D2LM6Le6LWVkPYeRRuXRjRNH
fund tx:                 D6RG18ofYQSpJzaQPAJQHZW7XZBRe674YEYrjUETLYGnB1et8pHc3nWa855AdwxRfLuqUQcc9D9rW9jntuVL7fY
timeout-refund tx:       56eyY1wgLnS3TdScJ6ciVpVY8bDXMCCt6v3jZEYvbzcaAmENVeRYKPZ5ekC13vfR65BZvizzwdigNULqT1FD9iGa
task account:            F2jbuu49cAxc9eDC9jGrQ1TDq8Mb5Ei79UL3Lz6AR4v
signed deadline:         1700000060
pre-refund status:       Funded
post-refund status:      Refunded
worker:                  11111111111111111111111111111111
result hash:             0x0000000000000000000000000000000000000000000000000000000000000000
vault token balance:     0
buyer token balance:     10000000
mint:                    Emteqou7zpWD42vbKNrbxjyCFCGzfC9MLkrQrq9ZUDRT
timeout vault:           Cx8EbkKKtK4babifUxkx45YVoze6aPxX6Q71T9a3VyUR
buyer token account:     4G9eWtjdL8sbLL6gBb2ioABZrbkxxrcr7wQZAK8UGdmz
deploy output:           examples/solana-devnet/summarize_url_timeout_spl.deploy.live.json
funding evidence:        examples/solana-devnet/summarize_url_timeout_job_spl.funding.live.json
timeout refund output:   examples/solana-devnet/summarize_url_timeout_job_spl.timeout-refund.live.json
settlement evidence:     examples/solana-devnet/summarize_url_timeout_job_spl.settlement.live.json
settlement index:        examples/index/solana.spl.timeout-refund.index.json
```

This proof exercises the timeout branch directly from `Funded -> Refunded`; no worker claim and no verifier failure are involved. The program accepts the same refund instruction tag with Clock sysvar as account 8, validates `now >= deadline_unix`, signs the SPL `TransferChecked` CPI as the vault authority PDA, and drains the vault back to the buyer token account.

## Scanner Shape

The EVM scanner reads `Funded` logs. The Solana scanner reads task account state:

- discover initialized task accounts
- verify task state matches signed intent fields
- optionally decode the SPL vault token account and prove its balance covers the signed amount
- emit a chain-neutral `tasc.funding.solana` evidence object
- admit that evidence through the same indexer boundary

## Near-Term Decision

Solana devnet now works well enough to continue on the faster-chain path. The completed-settlement scanner is `bin/scan-solana-settlement-live.js`; it emits `tasc.settlement.solana.spl_token`, which `bin/tascindex.js` admits as a `completed` index entry rather than claimable inventory.

The complete mechanics loop can now be planned or rerun as a fresh proof bundle:

```bash
npm run prove:solana-devnet:plan
GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run prove:solana-devnet
```

The live runner creates fresh task names and hashes, writes artifacts under ignored `examples/solana-devnet/proofs/`, runs SPL setup once, then proves three branches: pass release, verifier-failed refund, and timeout refund.

For the explicit `$10 in under 60 seconds` devnet measurement, use:

```bash
npm run earn:devnet:plan
GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run earn:devnet
```

This is the same guarded live proof runner with the release task deadline set to `60s`. The generated `proof-summary.json` includes a top-level `timed_payout` object with:

- `payout.display_reward`
- `payout.destination_token_account`
- `claim_signature`, `attest_signature`, and `release_signature`
- `timing.claim_to_release_ms`
- `timing.claim_to_completed_index_ms`
- `timing.under_60s_to_release_confirmation`
- `timing.under_60s_to_completed_index`

The measured window starts when the worker claim transaction starts and ends at release confirmation plus completed-index scan. It proves the devnet/test-token payout mechanics; production still needs real USDC/liquidity, deployed verifier operations, and abuse controls.

Validate the generated timing evidence with:

```bash
npm run validate:timed-payout -- examples/solana-devnet/proofs/<run-id>/proof-summary.json
```

Then run the real-money readiness gate:

```bash
npm run real:intent:plan
npm run real:intent:build -- examples/summarize_url.tasc \
  --buyer <buyer-wallet> \
  --verifier <verifier-wallet> \
  --program-id <program-id> \
  --token-mint <mainnet-usdc-mint> \
  --input url=<url>

# Sign .tascverifier/production-intent/production-intent.signing-payload.json
# with the buyer wallet, then attach the base58 Ed25519 signature:
npm run real:intent:attach-signature -- \
  --intent .tascverifier/production-intent/production-intent.intent.json \
  --signature <base58-wallet-signature>

npm run real:preflight:plan
npm run real:preflight -- \
  --production-rpc-url <mainnet-rpc-url> \
  --expected-genesis-hash <mainnet-genesis-hash> \
  --program-id <program-id> \
  --usdc-mint <mainnet-usdc-mint> \
  --buyer <buyer-wallet> \
  --worker <worker-wallet> \
  --verifier <verifier-wallet> \
  --buyer-usdc-token-account <buyer-usdc-account> \
  --worker-usdc-token-account <worker-usdc-account>

npm run real:payout:plan
npm run real:payout:build -- \
  --token-mint <mainnet-usdc-mint> \
  --task-account <task-account> \
  --vault-token-account <vault-token-account> \
  --destination-token-account <worker-token-account> \
  --fund-signature <sig> \
  --claim-signature <sig> \
  --attest-signature <sig> \
  --release-signature <sig> \
  --claim-to-release-ms <ms> \
  --claim-to-completed-index-ms <ms> \
  --production-rpc-url <mainnet-rpc-url>

npm run real:packet:plan
npm run real:packet:build -- \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --production-payout .tascverifier/production-payout-evidence.json \
  --production-rpc-url <mainnet-rpc-url> \
  --expected-genesis-hash <mainnet-genesis-hash> \
  --program-id <program-id> \
  --token-mint <mainnet-usdc-mint> \
  --buyer <buyer-wallet> \
  --worker <worker-wallet> \
  --verifier <verifier-wallet> \
  --buyer-usdc-token-account <buyer-usdc-account> \
  --worker-usdc-token-account <worker-usdc-account> \
  --task-account <task-account> \
  --vault-token-account <vault-token-account>

npm run real:readiness -- \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json \
  --production-payout .tascverifier/production-payout-evidence.json \
  --production-rpc-url <mainnet-rpc-url> \
  --expected-genesis-hash <mainnet-genesis-hash>
```

`real:intent:build` creates the unsigned mainnet buyer intent plus the exact canonical UTF-8 payload a wallet must sign. `real:intent:attach-signature` verifies the base58 Ed25519 wallet signature against the buyer address before writing the signed intent used by funding. `real:preflight` is read-only and checks mainnet RPC identity, deployed program account, role SOL balances, the verified USDC mint, buyer USDC funding capacity, and worker USDC destination readiness before a real run. `real:payout:build` creates the ignored local production payout artifact from mainnet signatures/accounts and read-only token-account balance checks. `real:packet:build` then assembles a sanitized production run packet with the timed proof, signed intent, payout evidence, redacted RPC host, live evidence checklist, and exact remaining commands. It must represent mainnet USDC, not devnet/test-token evidence, and none of these commands accept private keys or send transactions. `real:readiness` should still report `ready_for_goal: false` until that artifact is paired with a timed proof, `--production-rpc-url`, and `--expected-genesis-hash`. The live RPC check verifies the genesis hash, fund/claim/attest/release signature confirmations, vault token-account balance, and worker destination token-account balance.

The next real implementation steps are:

1. Add wallet-backed browser claim/attest controls once the static proof should become interactive.
2. Keep the browser/static index path chain-neutral by admitting Solana and EVM evidence through the same indexer boundary.
3. Add production-style finality/reorg handling and duplicate-task suppression before treating devnet behavior as production-ready.
4. Start dispute-path design now that pass/fail/timeout settlement is live-proven.
5. Turn proof bundles into a private-beta task feed that a buyer, worker, and verifier can operate from wallets.

That gives Global Tasc a credible faster-chain path without throwing away the EVM work.
