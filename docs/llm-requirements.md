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

## Where it runs: a tunnel, two doors, two backends (#119, #123, #124)

SlyTab never talks to an Ollama directly in production. `LOCAL_LLM_URL`
points at **`https://llm.slymega.com`**, a Cloudflare tunnel gated by
Cloudflare Access, which reaches a **front door** — nginx, `127.0.0.1:11435`
— which requires `LOCAL_LLM_TOKEN` and fans out to every backend listed in
its `backends` file.

**The relay is gone from this path.** Until 2026-08-19 the last mile was a
house relay entry publishing the model host on a public port; closing it
(#119) is what took receipt scanning down. The tunnel replaces it, and there
is a door on **each** house box, so scanning no longer dies with kdocker2.

The backends, and the ollama pinned on each — both are SlyTab's dependency
now, not the house's free choice, and neither moves without a corpus run:

| Backend | Hardware | ollama | Warm scan | Role |
|---|---|---|---|---|
| kdocker3 | Radeon AI PRO R9700 32 GB | **0.33.3** (`ollama/ollama:rocm`, digest-pinned) | **3.4 s** | the only **primary** — it serves everything |
| kdocker2 | iGPU | **0.30.10** | 6.7 s | **`backup`** — serves only when no primary is up |

Each door lists both, its own Ollama on loopback and the other box over the
LAN, so the addresses differ per door while the roles do not. The house set
this on 2026-09-03 (house-network-ops#102): weighting was offered and it chose
the stronger form, since a 3.4 s box and a 19 s cold prompt are not really
peers. Measured effect, corpus through the door: **10.2 s** for three
receipts, against 50.5 s and 31.8 s when both boxes were primaries.

Both run model `qwen2.5vl:7b`, digest `5ced39dfa4ba`. The house falls back to
`0.31.2-rocm` on kdocker3 if the corpus ever fails there — that is a house
change, not a SlyTab one. `scripts/ops/llm-proxy/README.md` is the runbook;
the short version:

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
  parse per **serving** backend at a time, the rest in a fair line with
  feedback (FR-4.10). Count serving backends, not listed ones — a `backup` is
  not one until a primary falls over, which is why two listed backends still
  means `1` today.

  And check before raising it, because a backend does not have to be
  concurrent. Measured through the door on 2026-09-03: two parses fired at the
  same instant finished in 3.5 s and 6.7 s, three in 3.5 / 6.7 / 9.9 — Ollama
  serves them strictly one at a time. Admitting more than it can run does not
  make anyone's receipt faster; it moves the wait inside the model call, where
  the queue cannot show a position or an ETA. The visible line is the point.
  The test is one command: fire two parses at the same instant and compare
  their two elapsed times. Equal means concurrent; doubled means a queue you
  cannot see.
- **Share** between backends is `weight=N` on the backends line, because the
  boxes are not equals: plain `least_conn` over a 3.4 s box and a 6.7 s box
  still sends half of every day's receipts to the slow one. `backup` keeps a
  box out of rotation until nothing else is up — which is what the house
  actually chose for the iGPU, and it is the reason `LOCAL_LLM_PARALLEL` is 1
  rather than 2.
- **The pinned model tag lives in two places** that must agree: the door's
  `model` file (what "healthy" means) and `LOCAL_LLM_MODEL` in the deployed
  config (what the API asks for). Change both in the same breath.
- **The availability probe still fits.** `ScanAvailabilityService` gives
  `/api/tags` 2 s to connect and 4 s in total, on purpose — it runs while a
  user waits for a screen. Cloudflare Access and the tunnel add roughly
  30–60 ms to a call that already answers in single-digit milliseconds.

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

### ollama 0.33.3 on kdocker3: the regression is gone (2026-09-03, #124)

The 0.32.5 breakage above does **not** reproduce on 0.33.3. Measured with
SlyTab's own `ReceiptCorpusTest` against `192.168.10.38:11434` from the dev
box, model `qwen2.5vl:7b` warm and resident, nothing else on the GPU:

| | result |
|---|---|
| Corpus, three consecutive runs | **3/3 pass each time** — 88930 / 80190 / 450000, currency `CLP`, 17 assertions |
| Wall clock, all three fixtures | 9.4 s warm (24.4 s on the cold first run) |
| Determinism, 5 identical parses per fixture at `temperature: 0` | **one distinct result per fixture, 15 parses** — currency, total, subtotal, tax, tip and every line item identical |
| Per-receipt latency | 1.8–3.6 s |

That settles the two questions #124 raised. The determinism worry came from a
receipt outside the corpus, where kdocker3 once read `currency: "GTQ",
currencyExplicit: true` off a street name ("Guatemala 4691") on an Argentine
receipt and once read `"$", false`. It did not recur on any corpus fixture —
but note what would happen if it did: `currencyExplicit: true` makes
`resolveCurrency` prefer the model's answer over the buyer's currency hint, so
that flap is a wrong currency, not a wrong-looking one. It is a property of
the model and the receipt rather than of the engine version, and the corpus
fixtures do not contain a receipt that provokes it.

So the version bind below is about kdocker2's 0.30.10. It does not generalise
to 0.33.3, which was never tested with the candidate models.

**There is no version where everything works** on 0.30.10, and the choice is a
package deal, not two independent decisions:

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

**Re-screened 2026-09-01 with the PHPUnit suite itself** (Ollama 0.30.10,
model warm and resident, nothing else on the GPU), same night as the pinned
model, back to back:

| | `qwen2.5vl:7b` (pinned) | `qwen3-vl:8b-instruct` |
|---|---|---|
| `ReceiptCorpusTest` | **OK, 3/3, 16 assertions, 14 s total** | FAIL 2/3 — totals and currency all exact, but `itemsIncludeMinor` misses 11129 and 11639 (the dropped-line-item gap below, unchanged) |
| Latency, warm | ~4 s/receipt | ~4 s/receipt — the 64–78 s recorded above was a cold or contended run |

So the pin **stays on `qwen2.5vl:7b`**. The candidate is now in the weekly
screen (`~dave/.slytab-corpus-candidates` on kdocker2, read by
`scripts/worker/model-corpus-check.sh`), so the day it starts reading whole
receipts shows up in the log without anyone re-running this by hand. The
door's `model` file and `LOCAL_LLM_MODEL` both still say `qwen2.5vl:7b`.

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

## Hosts

`LOCAL_LLM_URL=https://llm.slymega.com` — the Cloudflare tunnel, from the
production API host. A dev box on the LAN reaches either backend directly by
address (`http://192.168.10.38:11434`) and needs no credential for it.

**These hosts are production.** They are not scratch boxes: upgrading one, or
loading large models beside `qwen2.5vl:7b`, degrades live receipt scanning for
real users. On 2026-07-27 kdocker2 was upgraded to 0.32.5 during a
benchmarking session and receipt scanning silently produced nonsense until the
rollback. Before touching one, run the corpus; after touching it, run the
corpus again.

With two backends that matters more, not less: nginx spreads receipts across
both, so **one bad box makes a share of live scans wrong** rather than all of
them — which is exactly the kind of failure nobody reports.
`scripts/worker/model-corpus-check.sh` therefore runs the corpus against every
backend in the door's `backends` file, separately, every week.

## The endpoint is authenticated now (#119, #124)

The old address was a relay port on the public internet, and Ollama has no
authentication of its own: for a while, anyone who found `3308` had an
unrestricted vision model. It was switched off on 2026-08-19, which closed
the hole and stopped receipt scanning dead — there is no silent fallback to
Claude (§"If we ever enable the Claude fallback"), so uploads simply failed.

What replaces it is two doors, checked in that order:

1. **Cloudflare Access** on the tunnel that publishes `llm.slymega.com`,
   which admits a service token and nothing else. Same pattern as SlyTesla's
   `tesla.slymega.com`. It refuses with **403 and an HTML page**, or a
   redirect to its login screen, before the request reaches the house at all.
2. **nginx**, SlyTab's own front door, listening on the loopback address the
   tunnel dials and passing nothing through without SlyTab's bearer token. It
   refuses with **401** and the single word `unauthorized`. Source and
   instructions live in `scripts/ops/llm-proxy/`.

`ReceiptService::describeRefusal` tells those two apart deliberately: neither
answer is JSON, so without it both surface as a JSON syntax error naming
nothing, and they are fixed by different people in different places.

So a working production configuration is five variables:

| Variable | Why |
|---|---|
| `LOCAL_LLM_URL` | `https://llm.slymega.com` — the tunnel, not the relay |
| `LOCAL_LLM_MODEL` | unchanged — `qwen2.5vl:7b` |
| `LOCAL_LLM_TOKEN` | the front door's bearer token; without it every parse fails with `local model refused the token` |
| `LOCAL_LLM_CF_ACCESS_ID` | Cloudflare Access service token id |
| `LOCAL_LLM_CF_ACCESS_SECRET` | its secret; without the pair, every parse fails with `Cloudflare Access refused the request (HTTP 403)` |

`scripts/deploy-api.sh` writes all three credentials from `PROD_LLM_TOKEN`,
`PROD_LLM_CF_ACCESS_ID` and `PROD_LLM_CF_ACCESS_SECRET` in the repo env file.
All three are optional in the code: a dev box talking to a LAN Ollama directly
sends none of them and the request goes out exactly as it always did. The
Access pair is all-or-nothing — half a service token is refused exactly as
none is, so the id alone is not sent.

The availability probe carries the same headers as a parse
(`ScanAvailabilityService::headers()` mirrors `ReceiptService::localHeaders()`,
and a test asserts they stay identical). A probe missing a credential would
report scanning offline for precisely as long as it was working.
