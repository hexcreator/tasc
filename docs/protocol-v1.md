# Protocol V1

## Goal

Create infrastructure where a worker can discover, claim, complete, verify, and receive a small stablecoin payout fast enough for a sub-minute earning flow.

The protocol must make these facts explicit:

- The task is funded or payment-authorized before the worker starts.
- The task rules are canonical and hashable.
- Completion proof can be verified quickly.
- Settlement does not depend on trusting the buyer after completion.

## Stack

| Layer | V1 Choice | Why |
| --- | --- | --- |
| Settlement asset | USDC | Stable unit, broad support, easy `$10` mental model |
| First chain target | Base/EVM L2 plus Solana adapter path | EVM path is implemented through Solidity escrow and event admission; Solana now has dependencyless devnet keys/transfers, a local account-model adapter, a scanner-ready task-account ABI, and Rust source core |
| Marketplace | Off-chain signed task intents | Fast global discovery without on-chain listing costs |
| Payment adapter | x402-style signed payment or escrow deposit | Internet-native payment semantics |
| Language | TascLang | Purpose-built task contracts instead of chain-specific plumbing |
| Verifiers | Off-chain modules with on-chain attestations | Fast and extensible |

## Actors

- `buyer`: creates a task intent and funds escrow.
- `worker`: claims the task and submits output.
- `verifier`: checks output against the task's `verify` block.
- `reviewer`: handles subjective disputes when deterministic verification is not enough.
- `indexer`: gossips and serves signed task intents.
- `escrow`: holds funds and applies payout rules.

## Flow

1. Buyer writes a TascLang task.
2. Compiler emits canonical task JSON and `task_hash`.
3. Buyer signs `task_hash` and funds escrow.
4. Indexers publish the task as claimable.
5. Worker claims the task with a bonded identity or reputation key.
6. Worker submits output before deadline.
7. Verifier checks output and emits an attestation.
8. Escrow releases USDC to the worker, refunds the buyer, or routes to dispute handling.
9. Reputation ledger records buyer, worker, and verifier outcomes.

## Canonical Task Object

```json
{
  "kind": "tasc.task",
  "version": "0.1",
  "name": "summarize_url",
  "reward": { "amount": "10", "currency": "USDC" },
  "deadline": { "raw": "60s", "seconds": 60 },
  "inputs": [{ "name": "url", "type": "string" }],
  "outputs": [{ "name": "markdown", "type": "string" }],
  "verify": [
    { "op": "min_words", "args": ["120"] },
    { "op": "contains_citation", "args": ["input.url"] }
  ],
  "payout": [
    { "event": "pass", "destination": "worker" },
    { "event": "timeout", "destination": "buyer" }
  ]
}
```

## Hashing

The compiler must produce a deterministic SHA-256 hash over canonical JSON. The hash is the stable identifier for:

- buyer signatures
- escrow deposits
- worker claims
- verifier attestations
- dispute records
- reputation events

## Escrow Contract Shape

V1 escrow should stay small:

- `fund(taskHash, amount, token, buyer)`
- `claim(taskHash, worker)`
- `attest(taskHash, verifier, resultHash, verdict)`
- `release(taskHash)`
- `refund(taskHash)`
- `openDispute(taskHash)`
- `resolveDispute(taskHash, ruling)`

Only settlement-critical state belongs on-chain. Task content, output artifacts, verifier logs, and indexer metadata stay off-chain and content-addressed.

## Anti-Abuse

Sub-minute work is fragile because spam and fake completions can overwhelm value. V1 needs:

- buyer funding before listing
- worker claim bonds for abuse-prone categories
- verifier bonds for paid verification
- per-category rate limits
- duplicate output detection
- replay-resistant signatures
- reputation loss that is steeper than reputation gain

## TascLang Design Rules

TascLang should be:

- deterministic
- easy to parse without dependencies
- intentionally small
- chain-agnostic at the source level
- able to compile to EVM, Solana, or off-chain verifier targets later

It should not expose raw chain concepts in task files. Developers should never need to write token-account handling, PDA derivation, rent calculations, cross-program invocation wiring, ABI packing, or chain-specific serialization inside a task contract.

## V1 Build Order

1. Dependencyless TascLang parser and canonical hash. `done`
2. Local deterministic verifier runner. `done`
3. JSON schema and verifier manifest output.
4. Local publish-claim-attest-release simulation. `done`
5. EVM escrow contract interface. `done`
6. Wallet signature flow. `done: typed-data plus test signing/recovery`
7. Solidity compile artifact. `done`
8. Local EVM escrow execution. `ready: external local RPC required`
9. Base Sepolia mock-USDC harness. `ready: env-gated, not run on public RPC yet`
10. Signed-funded indexer admission gate. `done`
11. Escrow event funding evidence extraction. `done`
12. Dependency audit and bundled Ganache removal. `done`
13. Persisted RPC funding scanner. `done: validated with mock provider`
14. Testnet handoff manifest. `done: offline validated`
15. Static browser task feed. `done: dependencyless read-only Funded log scanner`
16. Scanner batch index admission. `done: signed catalog to claimable index`
17. Solana devnet funding spike. `done: dependencyless keygen, airdrop, balances harness`
18. Solana settlement adapter. `done: local account model, signed intent, funding evidence, index admission`
19. Solana program-account ABI and scanner boundary. `done: 276-byte task account, 121-byte fund instruction, funding evidence admission`
20. Solana Rust source core and deploy-readiness gate. `done: dependencyless source tests pass; blocked on Solana CLI/SBF toolchain for deploy`
21. USDC testnet escrow flow.
22. Claim protocol.
23. Reputation ledger.
24. Dispute/reviewer module.
