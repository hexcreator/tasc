# Task Intents V1

Task intents are the off-chain object a buyer signs before a task is globally indexed.

The intent binds the compiled task to the exact settlement context:

- buyer address
- task hash
- input hash for the concrete task input values
- escrow contract
- token contract
- amount in token base units
- absolute deadline
- verifier address
- nonce
- chain id

Without this binding, an indexer could list a task with mismatched settlement parameters, replay an old task onto a different chain/escrow, or show a worker inputs the buyer never signed.

## Input Boundary

The TascLang task describes the input schema:

```text
input url string
```

The buyer intent carries the concrete input values:

```json
{
  "inputs": {
    "url": "https://docs.cdp.coinbase.com/x402/welcome"
  },
  "input_hash": "0xad2e20b1f70ba6bf13c6ed2d8f246284beabb0ac70d9548f8691c730c0af4537"
}
```

The input hash is a SHA-256 bytes32 over canonicalized input JSON. It is included in the EIP-712 message and Solana intent message, so indexers and workers can detect if a feed tries to swap the work target after signing.

## Deadline Boundary

TascLang source uses a relative work window:

```text
deadline 60s
```

The EVM escrow contract needs an absolute Unix timestamp:

```text
deadline = now + 60
```

The intent generator accepts `--now` for deterministic tests. In production the client should use the buyer's current time, then the funding transaction should pass the same absolute deadline into `TascEscrow.fund`.

## EIP-712 Shape

The generated `typed_data` uses:

```text
domain.name = "Global Tasc"
domain.version = "0.1"
domain.chainId = target chain id
domain.verifyingContract = escrow address
primaryType = "TaskIntent"
```

`TaskIntent` fields:

```text
buyer address
taskHash bytes32
inputHash bytes32
escrow address
token address
amount uint256
deadline uint64
verifier address
nonce uint256
```

The buyer signs this typed data with an EVM wallet. The recovered signer must equal `message.buyer` before an indexer should publish the task.

## Example

```sh
node bin/tascintent.js create examples/summarize_url.tasc \
  --buyer 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 \
  --escrow 0x2222222222222222222222222222222222222222 \
  --token 0x3333333333333333333333333333333333333333 \
  --verifier 0x4444444444444444444444444444444444444444 \
  --chain-id 84532 \
  --nonce 1 \
  --input url=https://docs.cdp.coinbase.com/x402/welcome \
  --now 1800000000
```

For the example task, `$10 USDC` becomes `10000000` token base units when using 6 decimals.

## Signing

The dependencyless intent generator does not sign or recover ECDSA signatures. Use the separate signing harness:

```sh
npm run sign:example
npm run validate:signature
```

For production clients, use a wallet library or direct wallet RPC call:

- browser wallet: `eth_signTypedData_v4`
- server/test wallet: `viem`, `ethers`, or another audited EVM signing library
- contract-side verification later: EIP-712 digest plus ECDSA recovery
