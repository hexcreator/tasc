# Indexer Admission V1

Indexer admission is the first global-discovery gate.

An indexer should not publish a task just because a buyer produced a signed intent. It should publish only after it can pair that signed intent with funding evidence from the settlement chain.

## Inputs

Admission takes two objects:

- signed buyer intent: `tasc.intent.signature.eip712` or `tasc.intent.signature.solana`
- funding evidence: `tasc.funding.evm` or `tasc.funding.solana`

The signed intent proves who authorized the task. The funding evidence proves the exact escrow slot or Solana task/vault state was funded.

Signed intents may also carry worker-facing metadata: task name, display reward, relative deadline, concrete input values, input hash, and a compiled task summary. Admission preserves those fields in the index entry after verifying the task file hash matches the signed task hash when the source file is available locally.

Batch admission takes:

- a signed intent catalog: one JSON file or a directory of signed intent JSON files
- a scanner batch: `tasc.funding.batch.evm` or `tasc.funding.batch.solana`

The indexer matches scanner entries to signed intents by `task_hash`, then runs the same full admission checks for each match.

## Required Checks

For EVM evidence, the indexer must verify:

- EIP-712 signature recovers to `typed_data.message.buyer`
- funding status is `Funded`
- funding chain id equals the typed-data domain chain id
- funding task hash equals the signed task hash
- funding escrow equals both the signed message escrow and EIP-712 verifying contract
- funding buyer, token, amount, and deadline equal the signed message fields
- funding transaction hash, block number, and log index are well formed

For Solana evidence, the indexer must verify:

- Ed25519 signature verifies against `intent.message.buyer`
- signed intent hash matches the embedded Solana intent
- funding status is `Funded`
- funding cluster, program id, task hash, buyer, token mint, amount, deadline, and verifier match the signed intent message
- task PDA, vault, buyer, token mint, verifier, program id, and signature are well formed Solana base58 values
- slot, instruction index, and confirmation status are well formed

When Solana evidence includes optional SPL custody evidence, the indexer must also verify:

- custody kind is `tasc.custody.solana.spl_token`
- custody token program is the SPL Token Program
- custody vault token account equals the funding vault
- custody token mint equals the signed intent token mint
- custody required amount equals the signed intent amount
- custody token account balance is greater than or equal to the signed intent amount

Only after those checks pass can the index entry become `claimable`.

## Example Commands

Admit the good fixture and write an index file:

```sh
npm run index:admit
```

Confirm a mismatched funding fixture is rejected:

```sh
npm run index:reject-bad
```

Admit the scanner batch against the local signed intent catalog:

```sh
npm run index:admit-batch
```

Generate and admit the Solana settlement fixture:

```sh
npm run solana:demo-settlement
npm run index:admit-solana
npm run index:admit-solana-batch
```

Generate Solana program-account evidence and admit it:

```sh
npm run solana:program-fixture
npm run solana:scan-program-fixture
npm run index:admit-solana-program
```

Admit the live Solana SPL custody-backed funding evidence:

```sh
npm run index:admit-solana-spl-live
```

Run the deterministic validator:

```sh
npm run validate:indexer
npm run validate:solana-settlement
npm run validate:solana-program
npm run validate:solana-spl-escrow
```

## Output

The admitted fixture writes:

```text
examples/index/summarize_url.index.json
```

The scanner batch fixture writes:

```text
examples/index/funded.batch.index.json
```

The Solana fixtures write:

```text
examples/index/solana.summarize_url.index.json
examples/index/solana.funded.batch.index.json
examples/index/solana.program-account.index.json
examples/index/solana.spl.live.index.json
```

Each entry carries the signed intent hash, task hash, input hash, task input values, task summary, settlement tuple, funding event coordinates, signature recovery result, and signed intent source. Solana entries may also carry SPL custody fields when the scanner proves the vault token account balance. This is the object a worker-facing marketplace can serve as claimable inventory.

If a scanner entry cannot be admitted, batch output records it under `rejected_entries` with the task hash, funding event coordinates, and reason. Missing signed intents are rejected instead of silently dropped.

## Boundary

This is still a local admission proof. A production indexer also needs:

- RPC log ingestion for real escrow `Funded` events
- chain reorg handling and confirmation depth
- nonce consumption checks
- task expiration checks
- duplicate listing suppression
- signed intent gossip or catalog replication
- reputation and category filters
- production Solana finality/reorg policy before custody-backed devnet evidence can be trusted as production settlement
