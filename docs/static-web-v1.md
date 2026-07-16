# Static Web V1

The static web feed proves that Global Tasc task discovery does not require paid hosting.

The app is served from plain files in `web/`:

```text
web/index.html
web/styles.css
web/tasc-web-core.js
web/demo-index.js
web/app.js
```

There is no build step, no bundled dependency, no hosted database, and no required indexer service.

## Flow

```text
EVM:     browser -> RPC eth_blockNumber -> confirmed range -> RPC eth_getLogs -> Funded events -> local task cache
Solana:  browser -> RPC getAccountInfo(task_pda) -> decode 276-byte task account -> role/action readiness
Solana:  browser -> wallet sign -> RPC sendTransaction -> refreshed task-account status
Import:  paste/select tasc.index JSON -> merge entries -> refresh live Solana status
Submit:  markdown output -> tasc.worker.submission proof -> verifier ingestion -> tasc.attestation -> attest hash
```

The browser reads only `TascEscrow.Funded` logs. It decodes the same event shape used by the CLI scanner:

```solidity
event Funded(bytes32 indexed taskHash, address indexed buyer, address indexed token, uint256 amount, uint64 deadline);
```

The local cache uses browser storage. It stores:

- connection settings
- decoded funding entries
- connected Solana wallet address
- decoded Solana task account snapshots
- imported index entries and feed source metadata
- the next block cursor
- the last observed head block

## Inventory Import

The static app can load inventory without rebuilding `web/demo-index.js`.

Supported import payloads:

- `tasc.index` JSON files
- raw arrays of `tasc.index.entry` objects
- `tasc.solana-devnet.proof` summaries, when the referenced index JSON files are served from the same static host

Completed index entries replace older claimable entries for the same Solana task account, so proof bundles can show the final `Released` or `Refunded` state instead of duplicating the same task.

When entries include signed task metadata, the claimable card shows the display reward, relative deadline, concrete input URL, expected output field, verifier rules, and input hash. This keeps the worker's fast path inside the same feed artifact instead of requiring a separate task-description service.

## Worker Submission Capture

The task card can capture markdown output and build a `tasc.worker.submission` proof in the browser. The proof includes:

- task hash and input hash
- worker address when a wallet is connected
- markdown output
- verifier-compatible `sha256:<hex>` result hash
- Solana-ready `0x<hex>` result hash for attest transactions
- local preview checks for deterministic rules
- optional Solana `signMessage` signature when the wallet supports it

The captured hash is written into the Solana operator result-hash field, so a verifier can attest the same output hash without recomputing it by hand.

## Verifier Ingestion

Captured worker proofs can be ingested without adding a hosted dependency:

```sh
node bin/tascverifier-service.js ingest \
  examples/submissions/summarize_url_spl.worker-submission.json \
  --entry examples/index/solana.spl.live.index.json \
  --ledger examples/ledger.json
```

The verifier ingestion command treats the index entry as trusted task context and the worker proof as an output artifact. It recomputes the markdown hash, checks task hash, input hash, intent hash, inputs, verifier, and Solana settlement coordinates against the trusted entry, then runs the deterministic verifier rules.

The output includes:

- a normal `tasc.attestation`
- duplicate-result handling through the verifier ledger
- Solana-ready `result_hash_bytes32`
- the verifier wallet address that should submit the on-chain `attest`
- rejection of tampered result hashes, task hashes, and inputs

The same ingestion path is exposed by a dependencyless HTTP wrapper:

```sh
npm run verifier:api
```

Routes:

- `GET /health`
- `POST /v1/ingest`

The API starts from a trusted index file and optional ledger file, accepts either a raw `tasc.worker.submission` body or `{ "submission": ... }`, returns CORS headers for static-web callers, records accepted result hashes in memory for duplicate rejection during the process lifetime, and rejects invalid JSON, wrong methods, oversized bodies, and tampered proofs. Production operation still needs auth, durable proof artifacts, and persistent ledger storage.

## Solana Operator Console

The browser can connect to an injected Solana wallet provider, refresh bundled Solana task accounts from a devnet RPC, decode the live task-account status, and classify the connected wallet as buyer, verifier, worker, worker candidate, or spectator.

The action readiness model gates guarded wallet sends:

- `Funded` before deadline -> worker claim
- `Funded` after deadline -> buyer timeout refund
- `Claimed` -> verifier attest, or buyer timeout refund after deadline
- `Passed` -> worker release
- `Failed` -> buyer refund
- `Released` / `Refunded` -> complete

The send path is dependencyless:

- builds Global Tasc instruction bytes in `tasc-web-core.js`
- derives SPL buyer/worker token accounts and the vault-authority PDA in-browser
- compiles a legacy Solana message with a fresh RPC blockhash
- hands the transaction to an injected wallet provider
- falls back to `signTransaction` plus raw RPC `sendTransaction` when the wallet does not expose `signAndSendTransaction`

The UI requires the operator to enable wallet sends before any action button can submit a transaction.

Repeated scans advance from the cached cursor instead of rescanning the full range.

## Handoff Import

After a live testnet run writes:

```text
examples/testnet/base-sepolia.handoff.json
```

paste that public JSON into the web app and import it. The app derives:

- chain id
- escrow address
- funding start block
- confirmation depth

The RPC URL is not stored in the handoff because it may be private or rate-limited. Enter it locally in the browser.

## Free Hosting

Deploy the contents of `web/` as static files.

Good zero-fixed-cost targets:

- Cloudflare Pages
- a Cloudflare Worker static asset deployment
- GitHub Pages for non-commercial project/demo use
- any static file host that serves HTTPS

The canonical data source remains Base logs, not the static host. If the static host disappears, the same app can be re-hosted elsewhere and recover tasks by scanning the escrow contract again.

## Validation

Run:

```sh
npm run validate:web
npm run validate:verifier-ingest
npm run validate:verifier-api
```

The validator checks that:

- the web runtime loads no external scripts
- `tasc-web-core.js` uses no browser-runtime package imports
- the browser decoder matches the existing funding evidence fixture
- handoff import derives the expected scanner config
- the generated `eth_getLogs` filter matches the escrow and `Funded` topic
- the browser Solana task-account decoder matches a committed live Solana lifecycle account fixture
- the browser accepts `tasc.index`, raw entry arrays, and proof-summary import shapes
- the bundled Solana feed exposes signed task input metadata and input hash
- browser worker submission capture matches the CLI verifier result hash format
- verifier ingestion converts a captured proof into a `tasc.attestation` and Solana-ready attest hash
- verifier ingestion rejects duplicate, tampered-hash, tampered-task, and tampered-input cases
- the verifier API serves `/health`, accepts proof ingestion over HTTP, updates its in-memory duplicate ledger, and rejects invalid JSON, wrong methods, oversized bodies, duplicate proofs, and tampered inputs
- the browser can build wallet transaction payloads for Solana `claim`, `attest`, `release`, `refund`, and `timeout-refund`

## Limits

This is now a guarded operator surface, but still needs:

- live wallet QA in a normal browser extension environment
- hosted proof-bundle/index publication workflow
- deployed verifier API auth, durable artifact storage, persistent duplicate ledger, and verifier operations
- multi-RPC fallback
- reorg handling for cached entries
