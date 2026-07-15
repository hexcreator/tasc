# Static Web V1

The static web feed proves that Global Tasc task discovery does not require paid hosting.

The app is served from plain files in `web/`:

```text
web/index.html
web/styles.css
web/tasc-web-core.js
web/app.js
```

There is no build step, no bundled dependency, no hosted database, and no required indexer service.

## Flow

```text
browser -> RPC eth_blockNumber -> confirmed range -> RPC eth_getLogs -> Funded events -> local task cache
```

The browser reads only `TascEscrow.Funded` logs. It decodes the same event shape used by the CLI scanner:

```solidity
event Funded(bytes32 indexed taskHash, address indexed buyer, address indexed token, uint256 amount, uint64 deadline);
```

The local cache uses browser storage. It stores:

- connection settings
- decoded funding entries
- the next block cursor
- the last observed head block

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

## Limits

This is a read-only discovery proof. It still needs:

- wallet connection
- claim transaction UI
- claim status decoding
- attest/release transaction UI
- richer task metadata retrieval
- multi-RPC fallback
- reorg handling for cached entries
