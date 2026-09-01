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

## Where it runs: one front door, N backends (#119, #123)

SlyTab never talks to an Ollama directly in production. `LOCAL_LLM_URL`
points at a **front door** — nginx on kdocker2, `127.0.0.1:11435`, reached
through the house relay — which requires `LOCAL_LLM_TOKEN` and fans out to
every backend listed in its `backends` file. `scripts/ops/llm-proxy/README.md`
is the runbook; the short version:

- **Availability** is decided per backend, every minute, by
  `healthcheck.sh`: does `/api/tags` answer *and* list the pinned model? A
  backend that answers without the model is marked `down` — the door opening
  with the model missing is the worst case, because the request fails after
  the photo is taken. With no healthy backend the door answers 502 and the
  API's capabilities endpoint says scanning is offline (FR-4.8).
- **Residency** is enforced by the same check: if `/api/ps` shows the pinned
  model unloaded it is warmed back in with `keep_alive: -1`. Ollama forgets
  the pin across restarts, and the host restarts more than it should
  (house-network-ops#48); without this every reboot cost the next receipt a
  cold load or a timeout.
- **Concurrency** on the API side is `LOCAL_LLM_PARALLEL` (default 1): one
  parse per backend at a time, the rest in a fair line with feedback
  (FR-4.10). When a backend is added, raise it in `scripts/deploy-api.sh` and
  redeploy.
- **The pinned model tag lives in two places** that must agree: the door's
  `model` file (what "healthy" means) and `LOCAL_LLM_MODEL` in the deployed
  config (what the API asks for). Change both in the same breath.

## Hard requirements for any replacement model

1. **Vision.** It must accept an image in the `images` array of Ollama's
   `/api/chat`. Text-only models cannot do this job at all. Checked with
   `ollama show` on 2026-07-27: `gpt-oss:120b`, `laguna-xs-2.1` and the
   qwen3 text models are **not** vision models. `qwen3.6:35b-a3b` and
   `gemma4:31b` **are** (both report `completion vision tools thinking`) —
   an earlier revision of this file said otherwise. Neither has been
   corpus-tested: both are *thinking* builds, so they would need
   `think: false` added to `parseLocal` before they could be considered.
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
4. **An `-instruct` build, not a thinking one.** Bare `qwen3-vl:*` tags
   resolve to *thinking* builds, which spend 50–290 s per receipt — far
   past `LOCAL_LLM_TIMEOUT=90` — on what is a deterministic extraction
   task. The same model as `-instruct` answers in ~3.5 s.
5. **Deterministic enough.** Called with `temperature: 0`. A model that
   varies its answer between identical calls makes the money unreliable
   and the corpus test flaky.
6. **Stays resident.** Called with `keep_alive: -1`. A cold load costs
   ~20 s, which pushes the synchronous upload-and-parse response past the
   shared host's ~30 s limit; the client then reports a network failure
   even though the parse succeeded. Warm scans run 3–6 s.
7. **Fits the timeout.** `LOCAL_LLM_TIMEOUT=90` seconds, end to end.
8. **Has room to actually run.** Being resident is not the same as having
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

## Ollama 0.32.5 breaks `qwen2.5vl:7b` — do not upgrade past 0.30.10

Confirmed by A/B on the model host on 2026-07-27, same model file, same
digest, same three corpus fixtures, ample free VRAM in both runs:

| Ollama | Corpus result |
|---|---|
| 0.32.5 | **0/3** — degenerate multilingual token salad, empty replies, or truncated JSON; `done_reason` and `eval_count` absent from the response |
| 0.30.10 | **3/3 pass** — 88930 / 80190 / 450000, all exact, currency `CLP`, merchant matched |

The host was upgraded to 0.32.5 during unrelated benchmarking and **has been
rolled back to 0.30.10**, which restored a clean corpus pass. Receipt scanning
was broken for roughly 50 minutes (23:04–23:55 UTC).

This is distinct from the VRAM starvation described above, though the symptom
(model present and quietly wrong) is the same. The 0.32.5 failure persisted
with 54 GiB free and nothing else resident, so headroom was not the cause.

Note it fails specifically on the real ~1200×1600 **JPEG** photographs; a
small synthetic 620 px PNG still parsed correctly on 0.32.5. That is why the
symptom could be mistaken for a bad receipt rather than a bad engine.

To pin or restore the working version:

```bash
curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.30.10 sh
ollama -v   # expect 0.30.10
```

The installer rewrites `ollama.service` but leaves `ollama.service.d/`
drop-ins alone, so `OLLAMA_MODELS` / `OLLAMA_HOST` survive. It does **not**
preserve `keep_alive: -1` pins — the model unloads on restart and reloads cold
on the next scan, so re-run the corpus after any version change.

## The engine version bind

The ollama version is not a free choice: each one breaks something. Verified
by A/B on this host and independently reproduced with SlyTab's own
`ReceiptCorpusTest`.

| | ollama 0.30.10 **(current)** | ollama 0.32.5 |
|---|---|---|
| `qwen2.5vl:7b` (in production) | **3/3 exact, all line items** | **broken** — see the regression section above |
| `qwen3-vl:8b-instruct` | 3/3 exact, but 64–78 s — past the 90 s timeout in practice | 3/3 exact, **3.5–8.0 s** |
| `laguna-xs-2.1:q8_0` | fails to load (`missing tensor blk.0.attn_g.weight`) | works |

**There is no version where everything works**, and the choice is a package
deal, not two independent decisions:

- **Staying on 0.30.10** keeps receipt scanning correct, complete and fast,
  and costs laguna.
- **Moving to 0.32.5** obliges SlyTab to move to `qwen3-vl:8b-instruct` in
  the same change — on 0.30.10 that model takes 64–78 s, which users would
  experience as a hang. And it means accepting the dropped-line-item gap
  detailed under "Candidate evaluated" below.

Whoever changes the engine version owns both halves. Run the corpus after.

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

## Candidate evaluated: `qwen3-vl:8b-instruct`

Screened 2026-07-27 against all three corpus fixtures using the real
`parseLocal` prompt and schema, `Money::parsePrinted` replicated, currency
hint `CLP`. **Not adopted — offered for you to gate on the PHPUnit suite.**

| | `qwen2.5vl:7b` (current) | `qwen3-vl:8b-instruct` |
|---|---|---|
| Size | 6.0 GB | 6.1 GB |
| Totals (the money) | 3/3 exact | **3/3 exact** |
| Subtotal / tip | tip waived on Valle Lounge | **both exact, waiver unneeded** |
| Line items captured | 2 / 4 / 1 | **1 / 1 / 1** |
| Determinism @ temp 0 | assumed | **byte-identical over 3 runs** |
| Latency on 0.30.10 | 4–23 s | 3.9 / 78 / 64 s |
| Latency on 0.32.5 | broken | **3.5–8.0 s** |

**In its favour:** it reads the `PROPINA` tip that the current model misreads
as an item (exactly 7290), so the `mayMiss` waiver in `expected.json` would no
longer be needed. Output was byte-identical across three runs at
`temperature: 0`, satisfying requirement 4 properly rather than by assumption.

**Against it:** it drops one line item on each multi-item receipt — captured
58571 but missed 11129, captured 61261 but missed 11639, in both cases the
smaller of two items. Subtotal and total stay exact, so no money is wrong, but
`itemsIncludeMinor` in `ReceiptCorpusTest` **would fail on 2 of 3 fixtures**,
and the user sees an itemised split one line short. This reproduces on both
Ollama versions, so it is a property of the model, not the engine.

**The version bind.** The candidate is only *fast* on 0.32.5 (3.5–8.0 s); on
0.30.10 it runs 64–78 s, uncomfortably close to `LOCAL_LLM_TIMEOUT=90`. But
0.32.5 is the version that breaks `qwen2.5vl:7b`. So the two cannot be
mixed and matched — adopting the candidate means moving to 0.32.5 *and*
accepting the line-item gap, in one deliberate step, with the corpus re-run
after. Staying on 0.30.10 means keeping the current model.

Other candidates rejected outright:

- **`glm-ocr`** — fast (1.3 s) and #1 on OmniDocBench, but normalised
  `1,333.32` → `1333.32`. That is requirement 3, and it is issue #75 again.
- **`qwen3-vl:32b-instruct`** — returned 72900 instead of 450000 on the
  control receipt. A wrong total disqualifies regardless of size.
- **`qwen3-vl:30b-a3b-instruct`** — totals exact, but reported currency as
  `PESO`, which fails the `^[A-Z]{3}$` check in `parseLocal`.
- **Bare `qwen3-vl:*` tags** — these resolve to *thinking* builds, which take
  50–290 s per receipt. Always use the `-instruct` tags.

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

`LOCAL_LLM_URL=http://147.5.121.145:3308` (Ollama), plus **`LOCAL_LLM_TOKEN`,
which is now required** — see below. Reachable from the production API host
and from a dev box on the LAN.

**This host is production.** It is not a scratch box: upgrading it, or
loading large models beside `qwen2.5vl:7b`, degrades live receipt scanning
for real users. On 2026-07-27 it was upgraded to 0.32.5 during a
benchmarking session and receipt scanning silently produced nonsense until
the rollback. Before touching it, run the corpus; after touching it, run the
corpus again.

## The endpoint is authenticated now (#119)

That address is a relay port on the public internet, and Ollama has no
authentication of its own: for a while, anyone who found `3308` had an
unrestricted vision model. It was switched off on 2026-08-19, which closed
the hole and stopped receipt scanning dead — there is no silent fallback to
Claude (§"If we ever enable the Claude fallback"), so uploads simply failed.

What replaces it: nginx on the house machine, listening on the loopback
address the relay dials, passing nothing through without SlyTab's token.
Source and instructions live in `scripts/ops/llm-proxy/`.

So a working production configuration is now three variables, not two:

| Variable | Why |
|---|---|
| `LOCAL_LLM_URL` | unchanged — the relay port |
| `LOCAL_LLM_MODEL` | unchanged — `qwen2.5vl:7b` |
| `LOCAL_LLM_TOKEN` | the front door's token; without it every parse fails with `local model refused the token` |

`scripts/deploy-api.sh` writes it from `PROD_LLM_TOKEN` in the repo env file.
A dev box talking to a local Ollama directly needs none of this — absent the
variable, the request goes out exactly as it always did.
