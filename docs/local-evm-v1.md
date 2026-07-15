# Local EVM V1

This step proves the escrow can move ERC-20 balances on an actual EVM, without using a public RPC or real funds.

The execution path now uses an external local JSON-RPC node instead of bundling an in-process chain dependency.

This is intentional. `npm audit` flagged vulnerable transitive packages under the Ganache npm package, so the repo no longer ships Ganache as a dependency. Use a separately installed local node such as Anvil, Hardhat, or Ganache when you want to run the transaction flow.

The flow uses:

- an external local EVM JSON-RPC URL
- `MockUSDC` as a 6-decimal ERC-20 test token
- compiled `TascEscrow` bytecode from `build/TascEscrow.json`
- the canonical TascLang example task hash
- the local deterministic verifier's result hash

## Plan

```sh
npm run local-escrow:plan
```

The plan command sends no transactions. It lists the required environment:

```text
LOCAL_EVM_RPC_URL
GLOBAL_TASC_BUYER_PRIVATE_KEY
GLOBAL_TASC_WORKER_PRIVATE_KEY
GLOBAL_TASC_VERIFIER_PRIVATE_KEY
```

## Flow

After starting a local funded RPC and setting the private keys:

```sh
npm run local-escrow:flow
```

## Proven Flow

```text
mint -> approve -> fund -> claim -> attest -> release
```

Expected balances after release:

```text
buyer: 0
escrow: 0
worker: 10000000
```

`10000000` is `$10 USDC` in 6-decimal base units.

## Hashes

The local EVM test uses the real compiled task hash:

```text
0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45
```

and the verifier result hash:

```text
0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f
```

## Notes

The private keys must belong to accounts funded with local test ETH. Never reuse production keys for this flow.

This is not a public testnet flow yet. The next step is a Base Sepolia-style deployment/funding script using real RPC and faucet-funded test accounts.
