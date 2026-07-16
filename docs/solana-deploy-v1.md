# Solana Deploy V1

This is the handoff from local Solana scanner proof to live devnet settlement, plus the no-send production deploy preparation needed before a real mainnet USDC run.

The repo now has:

- a dependencyless JS scanner/ABI fixture
- a dependencyless Rust core crate for task-account and instruction bytes
- a deploy-readiness gate for local Solana tooling
- a guarded SBF build script that emits a deployable fund-processor artifact and records its hash
- a finalized Solana devnet deployment and fund transaction that produce live claimable index evidence
- a sanitized production deploy handoff that verifies the SBF artifact, manifest hash, and program id without sending transactions

It does not have a completed mainnet deployment or real USDC payout yet. Devnet SPL custody and release/refund mechanics are live-proven; production deployment is still a reviewed operator action.

## Commands

Validate the Rust source and ABI constants:

```sh
npm run validate:solana-source
```

Check whether this machine can build/deploy to Solana devnet:

```sh
npm run solana:deploy-readiness
```

Build the SBF artifact:

```sh
npm run solana:build-sbf
```

Preview the guarded devnet deploy command:

```sh
npm run solana:deploy-plan
```

Build the no-send mainnet deploy handoff:

```sh
npm run real:env:init:plan -- --env .env.solana-mainnet.local
npm run real:env:init -- --env .env.solana-mainnet.local
npm run real:env:plan -- --env .env.solana-mainnet.local
npm run real:env:validate -- --env .env.solana-mainnet.local
npm run real:deploy:plan
npm run real:deploy:build -- --env .env.solana-mainnet.local
npm run real:deploy:validate -- .tascverifier/production-deploy-handoff.json
```

`real:env:init` creates or updates the ignored `.env.solana-mainnet.local` file from `.env.example`, chmods it to `0600`, preserves existing values unless `--force` is used, can copy required values from the process environment with `--from-process-env`, derives standard buyer/worker USDC associated token accounts from public wallet + mint values when those token-account fields are blank, rejects private-key-like entries, and never prints the RPC URL. `real:env:*` checks the ignored `.env.solana-mainnet.local` file without printing the RPC URL, rejects private-key-like entries and devnet/test/local/example RPC hosts, and reports the public mainnet values still needed before preflight. `real:deploy:build` reads the generated program-id keypair file only to derive the public program id. It does not print key material, does not call RPC, does not send transactions, and stores only the RPC host.

Create a live devnet signed intent from the local buyer/verifier keys and generated program id:

```sh
npm run solana:live-intent
```

Preview the guarded fund transaction:

```sh
npm run solana:fund-plan:live
```

Preview the read-only live scanner:

```sh
npm run solana:scan-live-plan
```

Current expected build output:

```text
artifact: build/solana/global_tasc_solana_program.so
sha256: ec6793c4353360ca243caea97a3a15263808afff344e31eafaa39ca05e53c9bf
entrypoint symbol: present
```

## What Exists

Rust core source:

```text
programs/solana-tasc/Cargo.toml
programs/solana-tasc/src/lib.rs
```

SBF artifact metadata:

```text
build/solana-tasc.sbf.json
```

The Rust crate has no external Cargo dependencies. It encodes the same scanner ABI as the JS proof:

```text
task account size: 276 bytes
fund instruction size: 121 bytes
Funded status: 1
fund tag: 0
```

It validates:

- fund instruction decoding
- funded task account encoding/decoding
- claim, attest, and release state transitions
- constants matching the JS scanner ABI

The SBF artifact exports the raw Solana `entrypoint` symbol. It parses the loader-provided runtime buffer, validates the fund instruction and expected accounts, rejects missing signer/writable/owner checks, and writes the documented `276` byte task account as `Funded`.

The current processor expects a pre-created task account owned by the program. It does not yet create accounts by CPI or transfer SPL tokens into the vault.

## Live Devnet Proof

Current public proof:

```text
program id:       FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM
deploy tx:        4veC8ijRVhzgCcUU6DKXmB7RoF7YRZmtRxz5Esxfm9kzdAzuAPr3cHATe6gNjp1YyVD7JaVqmhSF1GPps5fvBqMg
fund tx:          BH2QJ4iWHFp9W6Tk4a27v5osyySBdhdcuswePAWjqTqXes26rVY1QeszcXhbnV6uyL4aH8fg12kfozGby2Swfqp
task account:     55mDcsddNiSvUKfrrRBbmP7mPeuT9UDf4kRL8EygvDEa
vault placeholder: CcsiF2rAKUt4evkNaFj7nJpfXtxqqZaxUu11mC1KxRb
status:           deploy tx finalized, fund tx finalized, scanned account status Funded
```

The live scan writes:

```text
examples/solana-devnet/summarize_url.task-account.live.json
examples/solana-devnet/summarize_url.funding.live.json
examples/index/solana.live.index.json
```

The scanner can preserve the actual funding transaction signature:

```sh
node bin/scan-solana-live.js scan examples/solana-devnet/summarize_url.signature.json \
  --signature BH2QJ4iWHFp9W6Tk4a27v5osyySBdhdcuswePAWjqTqXes26rVY1QeszcXhbnV6uyL4aH8fg12kfozGby2Swfqp
npm run index:admit-solana-live
```

The admitted index entry is `claimable` and references the live task account plus the funding transaction above.

## SPL Custody Boundary

The token-custody funding path is staged and partially live.

```sh
npm run validate:solana-spl-escrow
```

That validator proves:

- SPL Token `TransferChecked` instruction bytes for the signed reward amount
- legacy Solana message ordering with buyer token account, vault token account, token mint, and Token Program
- `global_tasc.fund` storing the vault token account as the task vault
- 165-byte SPL token account decoding into custody evidence
- index admission carrying custody proof
- underfunded custody evidence being rejected

The non-sending plan reports the staged SPL escrow shape:

```sh
npm run solana:fund-plan:live
```

The guarded setup transaction creates a deterministic devnet mint, buyer token account, and PDA-owned vault token account:

```sh
npm run solana:spl-setup-plan
GLOBAL_TASC_ALLOW_SOLANA_SPL_SETUP=1 npm run solana:spl-setup-send
npm run solana:spl-scan-live
```

Current public SPL setup proof:

```text
setup tx:             2p6vSHtZDa6FM48jwA1Ck4EQb1hTaE2b7eNf1YDB159HdkMoE9ZN59kXeLCboxvazaqW1Wh2Z5KVjS6UrVXr8DE3
mint:                 8WdRRCNVr8Du5Q1C1EeiMvqCRpSTBwWnHRjnx3FZ7KbC
buyer token account:  532DEeJ1PHjgd56Tzk86G5zFavXVwj4NBVHRrQaoUf6E
vault token account:  5pzDYJ55KMtFC5aH6uQSmRpBBBTyuENLCLsb2Ng9fexc
vault authority PDA:  Hb7UnP6kkDHUpRZARHQGdnat1vHmsEEyrGF2XjBmg8EQ
mint supply:          10000000
buyer token balance:  10000000
vault token balance:  0
```

The SPL account scan writes:

```text
examples/solana-devnet/spl-setup.live.json
examples/solana-devnet/spl-accounts.live.json
```

The next live increment is to use a fresh task account, transfer those buyer token units into the task vault with `TransferChecked`, call `global_tasc.fund`, then scan the vault token account into custody evidence.

## Guarded Commands

No user action is needed for local builds on this machine. The next user approval point is the devnet deploy transaction, because it uses the local Solana keypair and spends devnet SOL.

The deploy command is intentionally guarded:

```sh
GLOBAL_TASC_ALLOW_SOLANA_DEPLOY=1 npm run solana:deploy
```

Do not rerun that until you explicitly want to spend devnet SOL deploying a new program artifact.

After deployment, send the fund instruction against a pre-created task account and scan that live account state into `tasc.funding.solana`.

The fund transaction path is also guarded:

```sh
GLOBAL_TASC_ALLOW_SOLANA_FUND=1 npm run solana:fund-send:live
```

The sender builds one legacy transaction with:

- `system.create_account_with_seed` for the task account
- `system.create_account_with_seed` for the vault placeholder account
- `global_tasc.fund`

The current live intent uses the System Program address as a placeholder `token_mint` because real SPL token escrow is not live yet. That is enough to prove live task-account state mutation, not enough to represent real USDC settlement.

After the guarded fund transaction confirms, scan and admit the live account:

```sh
npm run solana:scan-live
npm run index:admit-solana-live
```

## Security Posture

This step added no npm production dependencies and no Cargo dependencies. The SBF build script uses only Node built-ins and the installed Solana platform tools. `cargo-build-sbf` generates a program keypair JSON next to the artifact; the script chmods that file to `0600` and `.gitignore` excludes `build/solana/*-keypair.json`.

Registry checks currently pass:

```text
npm audit: 0 vulnerabilities
npm audit signatures: 17 packages have verified registry signatures; 2 packages have verified attestations
```
