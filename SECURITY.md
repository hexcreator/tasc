# Security Policy

Tasc is a prototype and is not safe for mainnet funds.

## Supported Versions

No production version is supported yet. All current code is experimental.

| Version | Status |
| --- | --- |
| `main` | Research/devnet prototype |
| tagged releases | Not established yet |

## Reporting Issues

Do not disclose private keys, seed phrases, paid RPC URLs, or exploitable live-fund details in public issues.

For now, open a GitHub issue with a high-level description and mark it as security-sensitive in the title. Do not include secrets or exploit payloads. A private disclosure channel should be added before broader adoption.

## Current Risk Areas

- Solana program logic is not audited.
- EVM contracts are not audited.
- Devnet proofs are not production security guarantees.
- Verifier service and dispute economics are not implemented.
- Live commands can mutate public devnet state when guard flags are enabled.

## Dependency Posture

The project intentionally keeps runtime dependencies minimal. Before adding a dependency, document:

- why the standard library or local helper is not enough
- package maintainer and update posture
- audit/signature result where available
- blast radius if the package is compromised
