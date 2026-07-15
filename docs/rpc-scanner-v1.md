# RPC Scanner V1

The scanner turns live escrow logs into restartable funding batches.

It is read-only: it never sends transactions, never signs, and never mutates chain state.

## Flow

```text
RPC head -> confirmed block range -> Funded logs -> funding batch -> cursor
```

The scanner reads `TascEscrow.Funded` logs with:

- escrow address filter
- `Funded` topic filter
- `fromBlock` from the persisted cursor
- `toBlock` capped to the latest block with the configured confirmation depth

Each log is converted through the same funding evidence parser used by local fixtures, then checked against signed-intent admission rules in the validator.

## Commands

Show required environment:

```sh
npm run scan:plan
```

Run a live scan:

```sh
TASC_SCAN_RPC_URL=https://... \
TASC_SCAN_ESCROW=0x... \
TASC_SCAN_CHAIN_ID=84532 \
TASC_SCAN_START_BLOCK=123456 \
npm run scan:funded
```

Validate scanner behavior offline:

```sh
npm run validate:scanner
```

## State

The scanner writes:

```text
examples/scan/funded.cursor.json
```

The cursor records:

- chain id
- escrow address
- confirmation depth
- `next_from_block`
- last scanned block
- last observed head block

If the current safe block is behind `next_from_block`, the scanner returns an empty batch and preserves the cursor. That prevents duplicate indexing on restart.

## Batch

The scanner writes:

```text
examples/scan/funded.batch.json
```

The batch contains extracted `tasc.funding.evm` entries. A later multi-task indexer can match each entry by `task_hash` to a signed buyer intent and then admit it as claimable.

## Production Gaps

This is a single-process scanner. Production still needs:

- durable database storage instead of JSON files
- per-chain and per-escrow scanner workers
- RPC pagination and chunk sizing
- reorg rollback for already-admitted entries
- idempotent event identity using `(chain_id, escrow, tx_hash, log_index)`
- metrics and alerting for stuck cursors
