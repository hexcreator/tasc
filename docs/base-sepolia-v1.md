# Base Sepolia V1

This harness prepares the first public-testnet path for Global Tasc.

It still uses `MockUSDC`, not real USDC. The goal is to prove the same escrow lifecycle can run on a Base Sepolia-style public RPC before integrating real testnet tokens or production funding.

## Network Defaults

Base Sepolia defaults:

```text
chain id: 84532
currency: ETH
```

The harness requires `BASE_SEPOLIA_RPC_URL` instead of silently using a public endpoint. Public endpoints can be rate-limited, so a provider RPC is preferred.

Source: https://docs.base.org/base-chain/quickstart/connecting-to-base

## Safety Rules

- Private keys are read only from environment variables.
- Private keys are never accepted as command-line arguments.
- The transaction flow refuses to run unless `GLOBAL_TASC_ALLOW_TESTNET_TX=1`.
- The connected chain id must match `GLOBAL_TASC_EXPECTED_CHAIN_ID`, defaulting to `84532`.
- The harness deploys fresh `MockUSDC` and `TascEscrow` contracts for each run.

## Plan

```sh
npm run base:plan
```

This prints required env vars and configured signer addresses without sending transactions.

## Flow

```sh
BASE_SEPOLIA_RPC_URL=https://... \
GLOBAL_TASC_BUYER_PRIVATE_KEY=0x... \
GLOBAL_TASC_WORKER_PRIVATE_KEY=0x... \
GLOBAL_TASC_VERIFIER_PRIVATE_KEY=0x... \
GLOBAL_TASC_ALLOW_TESTNET_TX=1 \
npm run base:flow
```

To write scan-ready public metadata while running the flow:

```sh
BASE_SEPOLIA_RPC_URL=https://... \
GLOBAL_TASC_BUYER_PRIVATE_KEY=0x... \
GLOBAL_TASC_WORKER_PRIVATE_KEY=0x... \
GLOBAL_TASC_VERIFIER_PRIVATE_KEY=0x... \
GLOBAL_TASC_ALLOW_TESTNET_TX=1 \
npm run base:flow:handoff
```

Each signer needs enough Base Sepolia ETH for gas. The script runs:

```text
deploy MockUSDC
deploy TascEscrow
mint
approve
fund
claim
attest
release
```

Expected final balances:

```text
buyer: 0
escrow: 0
worker: 10000000
```

`10000000` is `$10 USDC` in 6-decimal base units.

## Offline Validation

```sh
npm run validate:base-sepolia
npm run validate:testnet-handoff
```

This verifies the env parser, transaction opt-in guard, default chain id, signer-address derivation, handoff shape, and scanner env derivation without making RPC calls.
