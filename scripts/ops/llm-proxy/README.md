# The front door in front of Ollama (#119 auth · #123 load sharing)

SlyTab's receipt scanning calls a vision model on house hardware. The route
from the API to that model runs over the public internet, and **Ollama has no
authentication of its own** — so on 2026-08-19 the relay entry that carried it
was switched off, which closed the hole and took receipt scanning down with it.

This is what makes it safe to turn back on, and — since 2026-09-01 — what
lets more than one machine serve it. nginx listens on `127.0.0.1:11435` (the
address the tunnel dials), answers `401` to everything that does not carry
SlyTab's token, and spreads receipts across every Ollama listed in `backends`
— by weight, since they are not equally fast — stepping around one that is
down.

```
API ──Cloudflare Access──▶ tunnel ──▶ nginx :11435 ──▶ 127.0.0.1:11434    (kdocker2, iGPU)
      service token                   bearer token ──▶ 192.168.10.38:11434 (kdocker3, R9700)
                                        least_conn      ▲
                                                        │ every minute:
                                      healthcheck.sh ───┘ advertises our model? resident?
```

Since #124 the path in front of the door is a Cloudflare tunnel rather than
the house relay, and there is a door on **each** house box, so scanning no
longer dies with kdocker2. The API sends `CF-Access-Client-Id` /
`CF-Access-Client-Secret` as well as its bearer token; see
`docs/llm-requirements.md`.

## Files

| file | what |
|---|---|
| `nginx.conf.tmpl` | the config, with `__TOKEN__` and `__UPSTREAMS__` placeholders |
| `render.sh` | template + token + backends → `nginx.conf`; validates with `nginx -t` first; `--apply` reloads |
| `healthcheck.sh` | the active check; renders `down` onto sick backends; warms the model; writes `status/status.json` |
| `backends.example` | copy to `backends`: one `host:port` per line, plus optional `weight=N` / `backup` |
| `docker-compose.yml` | `nginx:1.27-alpine`, host networking |

On kdocker2 these live in `/data/stacks/slytab/llm-proxy/` (owner `dave`),
next to three files that are **not** in the repo: `token` (0600, the shared
secret), `backends` (the pool), and `model` (the pinned model tag — what
"healthy" means). The rendered `nginx.conf` is 0600 too.

## First time, or after changing the template

```bash
D=/data/stacks/slytab/llm-proxy
[ -f "$D/token" ] || { openssl rand -hex 32 > "$D/token"; chmod 600 "$D/token"; }
[ -f "$D/backends" ] || echo 127.0.0.1:11434 > "$D/backends"
[ -f "$D/model" ]    || echo qwen2.5vl:7b   > "$D/model"     # keep in step with LOCAL_LLM_MODEL
bash "$D/render.sh"                     # writes nginx.conf (all backends up)
cd "$D" && docker compose up -d --force-recreate
bash "$D/healthcheck.sh"                # first status.json, first reload if needed

# it should answer 401, 401, 200, and a JSON status
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:11435/api/tags
curl -so /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer nope' http://127.0.0.1:11435/api/tags
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat $D/token)" http://127.0.0.1:11435/api/tags
curl -s -H "Authorization: Bearer $(cat $D/token)" http://127.0.0.1:11435/slytab/status
```

The health check runs from dave's crontab, every minute, logging **changes
only** to `~/llm-health.log`:

    * * * * * /data/stacks/slytab/llm-proxy/healthcheck.sh >> /home/dave/llm-health.log 2>&1

## Adding a machine

1. Install Ollama on it, pull the pinned model (`cat $D/model`), make sure it
   listens on the LAN (`OLLAMA_HOST=0.0.0.0:11434`) — **and only the LAN**.
   The front door authenticates; the backends still do not, so they must not
   be reachable from anywhere the front door is not.
2. Append `host:port` to `$D/backends`, with a `weight=` if it is not the
   equal of the others (below).
3. Wait a minute. `healthcheck.sh` sees it advertise the model, renders it
   into the upstream, reloads nginx, and warms the model in. `status.json`
   shows it. Nothing on the API side changes for that — but do raise
   `LOCAL_LLM_PARALLEL` in `scripts/deploy-api.sh` to the number of backends
   and redeploy, or the API will keep admitting one receipt at a time.
4. Run the corpus against the new box directly, before it takes live
   receipts — `LOCAL_LLM_URL=http://host:port vendor/bin/phpunit --filter
   ReceiptCorpusTest`. A backend that answers with a different ollama version
   or a re-pulled tag reads receipts *wrongly*, not not-at-all, and nginx
   cannot tell the difference. The weekly
   `scripts/worker/model-corpus-check.sh` then covers it on every run: it
   reads this same file and tests each backend separately.

### Weights, and a backup

A backends line may carry nginx upstream flags after the address:

```
192.168.10.38:11434 weight=3     # kdocker3, R9700 — ~3.4 s warm
127.0.0.1:11434                  # kdocker2, iGPU  — ~6.7 s warm
```

`least_conn` alone treats the boxes as equals, and they are not: measured on
2026-09-03 (#124) kdocker3 parses a receipt in 3.4 s warm where kdocker2's
iGPU takes 6.7 s, so an unweighted pool still sends half of every day's
receipts to the slow one. `weight=N` is the share; `backup` goes further and
keeps a box out of rotation entirely until no primary is up, which is what you
want for a machine that is a fallback rather than a peer.

`max_fails=` and `fail_timeout=` may be overridden the same way; anything else
is refused by `render.sh` rather than rendered, because an unknown word would
otherwise only surface later as an `nginx -t` failure with the door left on
its old config. At least one backend must be a primary — an upstream of
nothing but `backup` servers does not load.

`healthcheck.sh` reads only the address from these lines. Health and weight
are separate questions: the check decides `down`, the flags decide the share
among whatever is up.

Do **not** list a backend on one of kdocker2's own macvlan addresses: the
host cannot reach those (macvlan host isolation), so it would look dead for
ever. Other machines' LAN addresses are fine; the host network mode of the
container is what makes them reachable.

## What "healthy" means, and what happens when nothing is

A backend is healthy when `/api/tags` answers **and lists the pinned model**.
Answering without the model is the worst case — the door opens, the request
fails after the photo is taken — so that backend is rendered `down`. When
*no* backend is healthy every server is `down`, nginx answers 502, the API's
capabilities probe reads that as offline, and both apps show the scan buttons
disabled with the reason. That is the truth, and it is better than a spinner.

nginx's own passive check (`max_fails=1 fail_timeout=20s`) covers the gap
between cron ticks: one refused connection sidelines a backend for 20 s.
Requests are retried on the next backend **only** when the connection failed
outright (`proxy_next_upstream error http_502 http_503`) — never on timeout,
so a merely slow parse is not run twice on two boxes.

## Warming

Ollama forgets `keep_alive: -1` across restarts, and kdocker2 hard-reset
about eleven times in the week before this was written
(house-network-ops#48). Each reset unloaded the model; the next receipt then
paid a ~20 s cold load — or, with another consumer's 37 GB model on the GPU,
timed out at 90 s. `healthcheck.sh` reloads the pinned model with
`keep_alive: -1` whenever `/api/ps` shows it is not resident, so a receipt
never pays the cold start and our model is back on the GPU within a minute
of a reboot.

## The last mile is not ours

What carries this to the API is a **Cloudflare tunnel** published as
`llm.slymega.com` and gated by Cloudflare Access, built and owned house-side
(SlyWombat/house-network-ops#102) — the same pattern as SlyTesla's
`tesla.slymega.com`. It must point at **11435**, not 11434: pointing it back
at Ollama directly would restore the open endpoint this exists to close.

This replaced the house relay entry, which was closed on 2026-08-19 (#119)
and took receipt scanning down with it. SlyTab's side of the switch is
`LOCAL_LLM_URL`, plus the Access service token in `LOCAL_LLM_CF_ACCESS_ID` /
`LOCAL_LLM_CF_ACCESS_SECRET` — see `docs/llm-requirements.md`.

## Sizes

`client_max_body_size 32m` is generous on purpose and not at risk: receipts
are normalised to 1600px and under 2 MB before they are sent
(`ReceiptService::normalizeImage`), so the base64 body is a few MB at most.
