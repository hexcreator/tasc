# Funding Events V1

Funding evidence should come from escrow events, not hand-written JSON.

The first indexer admission gate accepted a `tasc.funding.evm` object. This step defines how that object is derived from a `TascEscrow.Funded` event log.

## Flow

```text
signed intent -> Funded event log -> funding evidence -> index admission
```

The extractor parses the escrow ABI, decodes the `Funded` event, rejects removed logs, enforces a minimum confirmation count, and emits funding evidence that can be admitted by `bin/tascindex.js`.

## Commands

Generate the deterministic event log fixture:

```sh
npm run funding:fixture-log
```

Extract funding evidence from the log:

```sh
npm run funding:extract
```

Validate extraction, reorg rejection, confirmation-depth rejection, and index admission:

```sh
npm run validate:funding
```

## Evidence

The checked fixture lives at:

```text
examples/events/summarize_url.funded-log.json
```

The extracted funding evidence lives at:

```text
examples/funding/summarize_url.from-log.json
```

`npm run index:admit` now uses the extracted funding evidence, so the claimable index fixture is downstream of an escrow event log rather than a manually trusted funding object.

## Reorg Boundary

The extractor rejects logs marked `removed: true`.

The validator currently requires 6 confirmations for the fixture path. A production indexer should compute confirmations from the current chain head, persist event identity as `(chain_id, escrow, tx_hash, log_index)`, and roll back any entries whose source log is later removed by the RPC provider.

## Dependency Posture

This step did not add dependencies.

Ganache was removed from the npm dependency tree after `npm audit` reported vulnerable transitive packages under it. Local escrow execution now expects an external local JSON-RPC node instead of bundling an EVM implementation inside this package.

`solc-js` remains for compiler artifact validation, with `tmp` overridden to `0.2.7` to avoid the advisory-flagged version range. `npm audit` and `npm audit signatures` passed after this change.
