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
- the next block cursor
- the last observed head block

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
```

The validator checks that:

- the web runtime loads no external scripts
- `tasc-web-core.js` uses no browser-runtime package imports
- the browser decoder matches the existing funding evidence fixture
- handoff import derives the expected scanner config
- the generated `eth_getLogs` filter matches the escrow and `Funded` topic
- the browser Solana task-account decoder matches a committed live Solana lifecycle account fixture
- the browser can build wallet transaction payloads for Solana `claim`, `attest`, `release`, `refund`, and `timeout-refund`

## Limits

This is now a guarded operator surface, but still needs:

- live wallet QA in a normal browser extension environment
- richer task metadata retrieval
- proof-bundle import beyond the single bundled demo index
- multi-RPC fallback
- reorg handling for cached entries
