# EVM Settlement V1

This document defines the first on-chain boundary for Global Tasc.

The local market demo already proves this lifecycle:

```text
funded -> claimed -> passed -> released
```

`TascEscrow.sol` maps that lifecycle to ERC-20 settlement.

## Hash Boundary

TascLang emits hashes as strings:

```text
sha256:28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45
```

The EVM contract receives the raw hash as `bytes32`:

```text
0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45
```

The adapter must strip the `sha256:` prefix and pass the remaining 32 bytes. The contract deliberately does not know about the string prefix.

## Amount Boundary

TascLang examples express rewards in human units:

```text
reward 10 USDC
```

The EVM `fund` call must receive token base units. For USDC, a `$10` task is normally:

```text
10000000
```

because USDC uses 6 decimals on the common EVM deployments. The compiler should eventually emit both display amount and chain amount once network/token metadata is selected.

## Contract Surface

`contracts/TascEscrow.sol` exposes:

- `fund(bytes32 taskHash, address token, uint256 amount, uint64 deadline)`
- `claim(bytes32 taskHash)`
- `attest(bytes32 taskHash, bytes32 resultHash, bool passed)`
- `release(bytes32 taskHash)`
- `refund(bytes32 taskHash)`
- `openDispute(bytes32 taskHash)`
- `resolveDispute(bytes32 taskHash, bool releaseToWorker)`
- `getTask(bytes32 taskHash)`

Only settlement-critical data is stored on-chain: buyer, worker, token, amount, deadline, result hash, verifier, and status.

## Compiler Artifact

The contract is compiler-checked with `solc-js`:

```sh
npm run compile:solidity
```

This writes:

```text
build/TascEscrow.json
```

The compile step also verifies that `abi/TascEscrow.abi.json` matches the compiler-emitted ABI.

## Local Execution

The local EVM execution flow uses `MockUSDC`, the compiled escrow artifact, and an external local JSON-RPC node:

```sh
npm run local-escrow:plan
npm run local-escrow:flow
```

It proves `fund -> claim -> attest -> release` moves `10000000` token base units from escrow to worker.

## Trust Model

V1 uses an owner-managed verifier allowlist. That is centralized, but intentionally simple for testnet. The production path should replace or constrain this with one of:

- verifier staking and slashing
- threshold attestations
- category-specific verifier registries
- buyer-selected verifier policies in the signed task intent

## State Transitions

```text
None -> Funded -> Claimed -> Passed -> Released
None -> Funded -> Refunded
None -> Funded -> Claimed -> Failed -> Refunded
None -> Funded -> Claimed -> Passed -> Disputed -> Released | Refunded
None -> Funded -> Claimed -> Failed -> Disputed -> Released | Refunded
```

Refunds are allowed to the buyer after verifier failure, or after deadline timeout while funded/claimed.

## Security Notes

- The contract is intentionally import-free for the first surface.
- ERC-20 calls are checked for boolean success.
- Release/refund paths are non-reentrant.
- Task content and submissions stay off-chain and content-addressed.
- The repo does not bundle Ganache; local execution uses an external RPC to keep npm supply-chain risk smaller.
- A real deployment needs fuzz tests, token behavior tests, and review before holding meaningful value.
