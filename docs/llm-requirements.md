# LLM requirements — receipt scanning

SlyTab uses a vision model for exactly one thing: turning a photograph of
a receipt into structured JSON (merchant, date, currency, line items,
subtotal, tax, tip, total). Nothing else in the product calls a model.

This file exists so that whoever manages the model host knows what SlyTab
depends on **before** upgrading it. Receipt scanning breaks silently and
expensively when a model changes underneath it — the parse still returns
JSON, it is just wrong, and wrong numbers become wrong money.

## What is pinned today

| | |
|---|---|
| Engine | Ollama on our own hardware |
| Model tag | **`qwen2.5vl:7b`** |
| Digest | `5ced39dfa4bac325…` (as of 2026-07-22) |
| Details | family `qwen25vl`, 8.3B params, Q4_K_M, ~5 GB |
| Configured in | `LOCAL_LLM_MODEL` in the deployed `config.env`, written by `scripts/deploy-api.sh`; code default in `ReceiptService::parseLocal` |

**We pin a tag, not a digest.** Ollama tags are mutable: re-pulling
`qwen2.5vl:7b` can replace it with a different build, and SlyTab would
follow it without noticing. If you need a hard guarantee, pin the digest
in `LOCAL_LLM_MODEL` and update it deliberately.

## Hard requirements for any replacement model

1. **Vision.** It must accept an image in the `images` array of Ollama's
   `/api/chat`. Text-only models cannot do this job at all. As of
   2026-07-27 the other models on the host (`gpt-oss:120b`,
   `qwen3.6:35b-a3b`, `gemma4:31b`, the qwen3 text models) are **not**
   vision models — none of them can replace this one.
2. **Structured output.** It must honour Ollama's `format` parameter with
   a JSON schema. SlyTab sends a strict schema and parses the reply with
   `json_decode(..., JSON_THROW_ON_ERROR)`; a model that emits prose or
   fenced code around the JSON fails outright.
3. **Amounts as printed TEXT, not numbers.** The schema declares every
   amount as a **string** copied character for character from the receipt
   (`"88.930"`, `"1,234.56"`). This is not stylistic — a JSON number
   cannot distinguish `88.930` from `88.93`, which made a Chilean receipt
   for 88,930 pesos import as 89 (issue #75). The server decides what the
   separators mean from the currency. A model that "helpfully" normalises
   amounts to numbers reintroduces that bug.
4. **Deterministic enough.** Called with `temperature: 0`. A model that
   varies its answer between identical calls makes the money unreliable
   and the corpus test flaky.
5. **Stays resident.** Called with `keep_alive: -1`. A cold load costs
   ~20 s, which pushes the synchronous upload-and-parse response past the
   shared host's ~30 s limit; the client then reports a network failure
   even though the parse succeeded. Warm scans run 3–6 s.
6. **Fits the timeout.** `LOCAL_LLM_TIMEOUT=90` seconds, end to end.
7. **Has room to actually run.** Being resident is not the same as having
   headroom — see below.

## VRAM: it needs room, not just a slot

Observed on 2026-07-27 at ~23:00, during benchmarking on the model host:

```
qwen2.5vl:7b          vram=8GB    until=2318   (ours, keep_alive -1)
laguna-xs-2.1:q8_0    vram=33GB   until=23:41  (benchmark)
```

With the 33 GB model co-resident, our model stayed loaded but **stopped
reading images**. A receipt that parses correctly in isolation came back as

```json
{"merchant": "Someoile", "total": ""}
```

— 20 tokens in 573 ms, against the usual 3–6 s. Under the full production
schema it degraded further and returned malformed JSON
(`Control character error`). `ReceiptCorpusTest` went from a clean pass to
two failures and an error, with the model file itself unchanged (same
digest, same timestamp).

So the failure mode to watch for is not "model missing" but **model present
and quietly wrong**, which is the worse one: the app still gets a reply, it
is just nonsense, and nonsense here becomes wrong money.

**What SlyTab needs:** enough free VRAM alongside `qwen2.5vl:7b` that its
image encoder is not starved. If a large model has to be loaded for
benchmarking, either accept that receipt scanning is degraded for the
duration, or unload it afterwards and re-run the corpus:

```bash
vendor/bin/phpunit --filter 'ReceiptCorpusTest'   # ~15s, confirms recovery
```

A quick way to check the host's current state:

```bash
curl -s $LOCAL_LLM_URL/api/ps | python3 -m json.tool   # what is resident
```

## Acceptance test before switching models

There is a real test for this. Do not switch on vibes.

```bash
bash scripts/dev/fetch-receipt-fixtures.sh          # real receipts from prod
LOCAL_LLM_URL=<host> LOCAL_LLM_MODEL=<candidate> \
  vendor/bin/phpunit --filter 'ReceiptCorpusTest|PrintedAmountTest'
```

`ReceiptCorpusTest` re-parses real uploaded receipts through the live
model and asserts the **totals exactly** — that is the money, and a
receipt parsing 1000× small is precisely the failure being guarded.
`PrintedAmountTest` is pure arithmetic and does not need a model.

A candidate model passes only if every fixture total matches. Subtotal and
tip are classification rather than arithmetic, so a model may decline to
label them (the current one misreads one layout's `PROPINA` as an item);
that is recorded per-fixture in `expected.json` rather than waved through
globally.

## If the model disappears

`RECEIPT_ENGINE=auto` picks the local model whenever `LOCAL_LLM_URL` is
set, and only falls back to Claude when it is not. So if `qwen2.5vl:7b`
is deleted from the host, scanning does **not** silently fall back — the
Ollama call errors and the user sees the upload fail. The Claude fallback
(`claude-opus-4-8`) is wired but **disabled**: `ANTHROPIC_API_KEY` is
empty in production, deliberately, because the privacy policy states that
receipt photos never leave our hardware.

**So: do not delete or repoint `qwen2.5vl:7b` without telling us.** If it
must go, either
- put a vision model of equivalent quality behind the same tag and let the
  corpus test decide, or
- give us the new tag name so `LOCAL_LLM_MODEL` can be updated and the
  suite re-run before the old one is removed.

## If we ever enable the Claude fallback

The privacy policy at `/slytab/marketing/privacy/` says photos are
itemised by a model we host ourselves and are never sent to a third-party
AI service. **Update the policy first**, then the Play Data safety answers,
then enable the key — in that order. Apple and Google both check the
policy against actual behaviour.

## Host

`LOCAL_LLM_URL=http://147.5.121.145:3308` (Ollama). Reachable from the
production API host and from a dev box on the LAN.
