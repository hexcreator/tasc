# Testnet Handoff V1

The handoff manifest bridges the Base Sepolia transaction flow to the read-only scanner.

It contains public metadata only:

- chain id
- deployed token and escrow addresses
- buyer, worker, and verifier addresses
- task hash and result hash
- `Funded` transaction hash, block number, and log index
- scanner environment values derived from those fields

It must not contain private keys or RPC secrets.

## Live Flow

Run the guarded testnet flow and write a handoff manifest:

```sh
BASE_SEPOLIA_RPC_URL=https://... \
GLOBAL_TASC_BUYER_PRIVATE_KEY=0x... \
GLOBAL_TASC_WORKER_PRIVATE_KEY=0x... \
GLOBAL_TASC_VERIFIER_PRIVATE_KEY=0x... \
GLOBAL_TASC_ALLOW_TESTNET_TX=1 \
npm run base:flow:handoff
```

The command writes:

```text
examples/testnet/base-sepolia.handoff.json
```

Then scan the funded event using the values from the handoff:

```sh
TASC_SCAN_RPC_URL=$BASE_SEPOLIA_RPC_URL \
TASC_SCAN_ESCROW=<handoff.contracts.escrow> \
TASC_SCAN_CHAIN_ID=<handoff.chain_id> \
TASC_SCAN_START_BLOCK=<handoff.funding_event.block_number> \
TASC_SCAN_CONFIRMATIONS=<handoff.funding_event.confirmations_required> \
npm run scan:funded
```

## Offline Validation

The checked fixture is:

```text
examples/testnet/base-sepolia.handoff.example.json
```

Validate it with:

```sh
npm run validate:testnet-handoff
```

The validator confirms the handoff shape, scanner env derivation, address/hash fields, and absence of private-key environment names.

## Boundary

This still uses `MockUSDC`; it is a testnet plumbing proof, not a real USDC integration. The next production-relevant step after this is a live Base Sepolia run that produces a real handoff, followed by scanning that deployed escrow and admitting the resulting funding evidence.
