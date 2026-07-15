# Solana Program ABI V1

This document defines the minimal Solana program/scanner boundary for Global Tasc.

It is not deployed yet. It is the executable ABI and minimal account-mutating processor a Solana program should satisfy so indexers can decode live task accounts into `tasc.funding.solana` evidence.

## Why This Exists

The `$10 in 60 seconds` loop needs claimable inventory before workers start. For Solana, that means an indexer must be able to prove:

- the buyer signed the task intent
- the task account is owned by the Global Tasc program
- the account status is `Funded`
- amount, buyer, verifier, token mint, deadline, nonce, and task hash match the signed intent
- the evidence can be admitted through the shared indexer

The dependencyless scaffold in [bin/tascsolana-program.js](/Users/chriscabral/Garage/global-tasc/bin/tascsolana-program.js) encodes the scanner side of that contract.

## Commands

Print the program ABI:

```sh
npm run solana:program-plan
```

Generate a deterministic task-account fixture and fund instruction:

```sh
npm run solana:program-fixture
```

Scan the task-account fixture into funding evidence:

```sh
npm run solana:scan-program-fixture
```

Admit the scanned funding evidence:

```sh
npm run index:admit-solana-program
```

Validate the whole boundary:

```sh
npm run validate:solana-program
```

## Generated Files

```text
examples/solana-program/summarize_url.program-spec.json
examples/solana-program/summarize_url.fund-instruction.json
examples/solana-program/summarize_url.task-account.json
examples/solana-program/summarize_url.funding.from-account.json
examples/index/solana.program-account.index.json
```

## Task Account

The task account is a fixed `276` byte account.

Important fields:

- `discriminator`: first 8 bytes, `fe5a9b1a20f08f03`
- `status`: `Funded` is `1`
- `task_hash`: 32-byte TascLang task hash
- `buyer`, `worker`, `verifier`, `token_mint`, `vault`: Solana pubkeys
- `amount`, `deadline_unix`, `nonce`: little-endian `u64`
- `result_hash`: zero until attestation
- `created_slot`, `updated_slot`: little-endian `u64`

The scanner rejects accounts whose decoded fields do not match the signed Solana intent.

## Fund Instruction

The fund instruction is `121` bytes:

```text
tag:           u8, value 0
task_hash:     bytes32
amount:        u64 little endian
deadline_unix: u64 little endian
nonce:         u64 little endian
token_mint:    pubkey
verifier:      pubkey
```

The expected accounts are:

```text
buyer       signer writable
task        writable
vault       writable
token_mint  readonly
verifier    readonly
```

## Scanner Contract

The scanner input is:

- a signed Solana buyer intent
- a Solana account owned by the Global Tasc program
- transaction metadata: signature, slot, instruction index, confirmation status

The scanner output is `tasc.funding.solana`, which can be admitted with:

```sh
npm run index:admit-solana-program
```

This is the direct bridge from future live Solana program state to worker-facing claimable inventory.

## Source Processor

The Rust core and minimal fund processor live at:

```text
programs/solana-tasc/src/lib.rs
```

Validate it with:

```sh
npm run validate:solana-source
```

The Rust crate has no external Cargo dependencies. It tests the same `276` byte task account and `121` byte fund instruction that the JS scanner uses.

Build the SBF artifact with:

```sh
npm run solana:build-sbf
```

That emits `build/solana/global_tasc_solana_program.so` plus `build/solana-tasc.sbf.json`. The artifact exports the Solana `entrypoint` symbol, parses the loader-provided runtime buffer, validates the first five fund accounts, and writes the `276` byte task account for a valid fund instruction.

The current processor expects a pre-created task account owned by the program. It does not yet create accounts by CPI or move SPL tokens into the vault.

The devnet transaction sender creates the task and vault placeholder accounts with System Program `create_account_with_seed`, using the buyer as the base address. This keeps the task and vault addresses deterministic from the signed intent and generated program id without adding task/vault private keys.

The live scanner reads that deterministic task account with `getAccountInfo`, decodes the `276` byte account, emits `tasc.funding.solana`, preserves the actual funding transaction signature when provided, and can admit the result through the existing indexer.

## Next Step

The guarded deploy/fund/scan sequence has been executed on devnet. The next implementation step is real SPL token escrow movement, followed by live `claim`, `attest`, `release`, and `refund` instructions.

Run:

```sh
npm run validate:solana-source
npm run validate:solana-fund-tx
npm run validate:solana-live-scan
```

Those commands validate the current no-dependency source, transaction builder, and live scanner boundary.
