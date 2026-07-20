# Production Mainnet Runbook

This runbook repeats the smallest proven real-money loop:

```text
buyer funds 10 USDC -> worker claims -> verifier attests pass -> worker releases
```

It is for controlled operator runs only. Tasc has a verified Solana mainnet proof, but it is not audited and is not ready for unsupervised public funds.

## Proven Baseline

The first successful mainnet proof used Solana USDC and completed the claim-to-release path in `19852ms`.

```text
program id:      FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM
usdc mint:       EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
task account:    G3tbuXWGXFPZGLVbiJvPp6iWHoP7eS3rbsarZ4AGrpqx
vault token:     23mmUH5FuFXniyP1gMJS7YQoXCK64CbtmzNmU5RPp3WH
fund tx:         3aegCSLiMak8BYwuXux1sUUcK1T5gVNEdEM1bZ4PR2PG7h9aMijp9pMN5oLFW2MdSDYgEs8VgnjpQHJVuyuwFUUE
claim tx:        55DphbFxouhdH97Q8Qu27z9WQ8Uw2rEPpqdAkx5R1oDn9ewMN4EnWUzs4gzPPdDbAn5sp35PUKT6v1WtCagqPfAS
attest tx:       4XqT8XWS7Cb7Wsh5d9dv15LdDTbjrN44xxaYUAYsKftzZ8G1TnZoe5GEpft3xugjZPXMPaypPUrTUfoNPdRo94ik
release tx:      2LBTQAv6cvh5q28QfNGdP1bUAmRVdycbzRVfrmLCyfSxQgKZu759xhHypUpSUKT8k6qAvQ4zSUw9iWDRE1eHCUXU
final status:    Released
vault balance:   0
worker received: 10000000 USDC base units
```

Final readiness passed with live RPC verification of the Solana genesis hash, all four signatures, the decoded released task account, the empty vault token account, and the worker destination token balance.

## Safety Rules

- Use a fresh budget policy before every spend run.
- Keep `.env.solana-mainnet.local`, keypair files, and `.tascverifier/` out of git.
- Never paste private keys into browser pages or committed files.
- Prefer the browser wallet submitter for normal operator runs.
- Use the local signer only for explicit, owner-private Solana keypair files.
- Stop after any timeout, dropped transaction, mismatched account, or failed readiness check.
- Treat timeout refund as the recovery path for expired funded or claimed tasks.

## Preflight

Install and validate the safe local surface:

```sh
npm install
npm run demo
npm run validate:dependencies
```

Initialize and review the private mainnet env file:

```sh
npm run real:env:init -- --env .env.solana-mainnet.local
npm run real:env:validate -- --env .env.solana-mainnet.local
```

Run the no-spend restart gates:

```sh
npm run real:pause -- --env .env.solana-mainnet.local
npm run real:budget -- --env .env.solana-mainnet.local
npm run real:resume -- --env .env.solana-mainnet.local
```

Run read-only live preflight:

```sh
npm run real:preflight -- --env .env.solana-mainnet.local
```

## Build The Run

Build and sign the buyer intent:

```sh
npm run real:intent:build -- examples/summarize_url_timeout_job.tasc \
  --env .env.solana-mainnet.local \
  --input url=<url>
```

Sign the canonical payload with the buyer wallet, then attach the base58 Ed25519 signature:

```sh
npm run real:intent:attach-signature -- \
  --intent .tascverifier/production-intent/production-intent.intent.json \
  --signature <buyer-signature>
```

Start the capture file:

```sh
npm run real:capture:init -- \
  --env .env.solana-mainnet.local \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json
```

Build funding:

```sh
npm run real:fund:build -- \
  --env .env.solana-mainnet.local \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json
```

Submit `.tascverifier/production-fund-transaction.json` with the buyer wallet, then record it:

```sh
npm run real:capture:record -- \
  --transaction .tascverifier/production-fund-transaction.json \
  --signature <fund-sig>
```

## Submit Lifecycle

Build and submit the worker claim:

```sh
npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action claim \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account>

npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-claim.json \
  --signature <claim-sig> \
  --claim-started-at <iso-claim-started>
```

Build and submit verifier attest:

```sh
npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action attest \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account> \
  --verdict pass \
  --result-hash <0x-result-hash>

npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-attest.json \
  --signature <attest-sig>
```

Build and submit worker release:

```sh
npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action release \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account>

npm run real:capture:record -- \
  --transaction .tascverifier/production-lifecycle-release.json \
  --signature <release-sig> \
  --release-confirmed-at <iso-release-confirmed> \
  --completed-indexed-at <iso-completed-indexed>
```

## Submit Options

Use the guarded browser submitter:

```sh
npm run real:submitter:serve
```

Open the printed localhost URL, paste the generated artifact, connect the required role wallet, enable production sends, submit, and run the generated capture command.

Use the guarded local signer only when the signer keypair file is owner-private (`0600`) and already matches the artifact signer:

```sh
GLOBAL_TASC_ALLOW_PRODUCTION_LOCAL_SEND=1 npm run real:local:send -- \
  --env .env.solana-mainnet.local \
  --transaction .tascverifier/production-lifecycle-release.json \
  --keypair <worker.json>
```

The local signer verifies the public address, signs only the artifact message bytes, sends through RPC, and does not print key material.

## Timeout Refund

If the task expires before successful release, build a buyer-signed timeout refund:

```sh
npm run real:lifecycle:build -- \
  --env .env.solana-mainnet.local \
  --action timeout-refund \
  --signed-intent .tascverifier/production-intent/production-intent.signature.json \
  --task-account <task-account>
```

Submit `.tascverifier/production-lifecycle-timeout-refund.json` with the buyer wallet. After a timeout refund, rerun preflight and build a fresh intent before another attempt.

## Prove Readiness

Build payout evidence, assemble the packet, and run the final live gate:

```sh
npm run real:capture:validate
npm run real:capture:payout -- --env .env.solana-mainnet.local

npm run real:packet:build -- \
  --env .env.solana-mainnet.local \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json

npm run real:readiness -- \
  --env .env.solana-mainnet.local \
  --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json \
  --production-payout .tascverifier/production-payout-evidence.json
```

The run counts only if `real:readiness` returns `ready_for_goal: true`.
