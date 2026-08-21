# The front door in front of Ollama (#119)

SlyTab's receipt scanning calls a vision model on the house machine. The
route from the API to that model runs through a relay that publishes it on
the public internet, and **Ollama has no authentication of its own** — so on
2026-08-19 the relay entry was switched off, which closed the hole and took
receipt scanning down with it.

This is what makes it safe to turn back on. nginx listens on
`127.0.0.1:11435` — the address the relay dials — and answers `401` to
everything that does not carry SlyTab's token. The API sends it as
`Authorization: Bearer …` (`LOCAL_LLM_TOKEN`, written into `config.env` by
`scripts/deploy-api.sh` from `PROD_LLM_TOKEN`).

## Where it runs

`/data/stacks/slytab/llm-proxy/` on kdocker2. These files are the source; the
copy there is rendered from the template with the token substituted, is
`0600`, and the token itself lives in `token` beside it — generated on that
machine, never in this repository.

    # first time, or after changing the template
    D=/data/stacks/slytab/llm-proxy
    [ -f "$D/token" ] || openssl rand -hex 32 > "$D/token" && chmod 600 "$D/token"
    sed "s|__TOKEN__|$(cat $D/token)|" "$D/nginx.conf.tmpl" > "$D/nginx.conf"
    chmod 600 "$D/nginx.conf"
    cd "$D" && docker compose up -d --force-recreate

    # it should answer 401, 401, 200
    curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:11435/api/tags
    curl -so /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer nope' http://127.0.0.1:11435/api/tags
    curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat $D/token)" http://127.0.0.1:11435/api/tags

## The last mile is not ours

The relay entry that carries this to the API lives in **SlyTesla's** tree,
`/data/stacks/tesla-log/relay/client.toml`, and must point at **11435**, not
11434 — pointing it back at Ollama directly would restore the open endpoint
this exists to close:

    [client.services.slytab-ollama]
    token = "default_token"
    local_addr = "127.0.0.1:11435"

Then `docker restart tesla-relay-client`. Receipt scanning is down until that
happens.

## Sizes

`client_max_body_size 32m` is generous on purpose and not at risk: receipts
are normalised to 1600px and under 2 MB before they are sent
(`ReceiptService::normalizeImage`), so the base64 body is a few MB at most.
