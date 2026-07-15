# Wallet Signing V1

This step proves a buyer intent can be signed and recovered.

The intent generator emits EIP-712-compatible typed data. The signing harness uses `ethers` only for wallet signing and recovery; the core TascLang compiler, verifier, and local market simulation remain dependencyless.

## Test Fixture

The checked-in fixture uses the public Hardhat/Anvil test key:

```text
address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

This key is public and must never hold real funds. It is only for deterministic local signatures.

## Commands

Regenerate the intent and signature fixtures:

```sh
npm run intent:write-example
npm run sign:write-example
```

Verify the signature:

```sh
npm run validate:signature
```

## Real Wallet Path

For a real buyer wallet, avoid passing private keys directly on the command line. Use an environment variable for local test automation:

```sh
BUYER_PRIVATE_KEY=0x... node bin/tascsign.js sign examples/intents/summarize_url.intent.json --private-key-env BUYER_PRIVATE_KEY
```

For production clients, prefer wallet RPC:

```text
eth_signTypedData_v4
```

Before an indexer publishes a task globally, it must verify:

- signature is valid for the typed data
- recovered signer equals `typed_data.message.buyer`
- intent hash matches the signed intent content
- escrow/token/amount/deadline match the funding transaction
- nonce has not been consumed
