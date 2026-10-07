# SlyTab — Production Deployment

**Deployed 2026-07-22 · live at [electricrv.ca/slytab](https://electricrv.ca/slytab)**

## Architecture (as deployed)

The web tier runs on the electricrv.ca cPanel host; **the database runs at
home on kdocker2**, reached through the SlyTesla rathole tunnel — chosen when
the cPanel account hit its 3-database limit, and it keeps all SlyTab data on
our own hardware.

```
Browser ── https://electricrv.ca/slytab ──────────────┐
                                                      ▼
        cPanel (PHP 8.3, shared hosting)     public_html/slytab/   SPA (Vite dist)
                                             public_html/slytab/api/  index.php shim + .htaccess
                                             ~/slytab/api/         PHP code + vendor (above web root)
                                             ~/slytab/config.env   runtime secrets (above web root)
                                                      │
                              PDO / MySQL over TLS (CA-pinned)
                                                      ▼
        Oracle A1 relay VM (147.5.121.145)   rathole server :3307
        · OCI security list + iptables restrict 3307 to the cPanel IP (+ home IP)
                                                      │  rathole tunnel (:2333 control)
                                                      ▼
        kdocker2 (home)                      tesla-relay-client (host network)
                                             ├ :3307 → 127.0.0.1:3306 → slytab-mysql
                                             │   └ db slytab_prod, user slytab_prod REQUIRE SSL
                                             └ :3308 → 127.0.0.1:11434 → Ollama (qwen2.5vl:7b)
                                                 └ receipt itemization on our own GPU
```

## Key facts

| Piece | Where / value |
|---|---|
| API base | `https://electricrv.ca/slytab/api/v1` (Slim basePath `/slytab`) |
| Admin endpoints | `POST /slytab/api/internal/{migrate,fetch-rates}` with `X-Admin-Token` |
| Prod DB | `slytab_prod` on kdocker2's `slytab-mysql`, via VM `147.5.121.145:3307`, TLS required, CA pinned (`scripts/prod/mysql-ca.pem` — public cert) |
| Secrets | Local repo `.env` holds `CPANEL_*`, `WEB_ROOT`, and all `PROD_*` values; the host's copy lives in `~/slytab/config.env` (0644, above web root) |
| Receipt scanning | **Local vision model** (qwen2.5vl:7b on kdocker2's Ollama) via VM `:3308` — photos never leave home; ~3-6s/scan warm. The API pins the model (`keep_alive: -1`) because a cold load adds ~20s and pushes the synchronous parse response past the host's ~30s limit (scan then fails client-side though the parse succeeds). After an Ollama restart the first scan still pays one cold load. `RECEIPT_ENGINE=auto` prefers local, uses Claude only if `ANTHROPIC_API_KEY` is set |
| Rathole configs | VM `/etc/rathole/server.toml` (systemd `rathole-server`); kdocker2 `/data/stacks/tesla-log/relay/client.toml` (`tesla-relay-client`, watched by `relay-guard.sh`) — both have `.bak` copies from before the SlyTab service was added |
| OCI | Port 3307 opened in the VM's security list ("SlyTab MySQL tunnel" rules); backup of prior rules at kdocker2 `/tmp/sl-ingress-backup.json` |

## Recurring jobs (kdocker2 — always on, no cPanel cron needed)

Five scheduled jobs, all UTC. They began as crontab lines of the admin login;
house IT is moving them to systemd timers running as the unprivileged
`slytab` service account (#129, house-network-ops#130) — same times, no
docker group, no home under `/home`, logs in `/var/log/slytab/`.

| Job | When | Script (as installed) | Source in this repo |
|---|---|---|---|
| DB backup → `backups/`, 30-day retention | 03:20 daily | `/data/stacks/slytab/backup.sh` | `scripts/ops/kdocker2/backup.sh` |
| ECB rate fetch | 06:10 daily | `/data/stacks/slytab/fetch-rates.sh` | `scripts/ops/kdocker2/fetch-rates.sh` |
| Store-release watcher | 12:00 daily | `<worker>/Splitwise/scripts/worker/store-release-watch.sh` | same path |
| LLM-proxy health check | every minute | `/data/stacks/slytab/llm-proxy/healthcheck.sh` | `scripts/ops/llm-proxy/` |
| Receipt-corpus model check | Sun 13:00 | `<worker>/Splitwise/scripts/worker/model-corpus-check.sh` | same path |

`<worker>` is `/opt/slytab-worker` once moved (a root-owned clone,
read-only to `slytab`), `~/slytab-worker` before. Secrets for the first two
live in `/data/stacks/slytab/cron.env` (0600, owned by whichever account runs
them); the worker scripts read the clone's own `.env`.

**Nothing in these scripts assumes a home directory.** Locations come from the
environment, and every default is the pre-move location, so an unset variable
means "as it always was":

| Variable | Used by | Default |
|---|---|---|
| `SLYTAB_ENV_FILE` | every script that reads secrets | the checkout's `.env`; `cron.env` for backup/fetch-rates |
| `SLYTAB_STATE_DIR` | store-release / TestFlight markers; corpus candidates + their FAIL memory | `scripts/worker/` (markers); `$HOME` (corpus) |
| `SLYTAB_LOG_DIR` | fetch-rates.log, worker.log | `/data/stacks/slytab`; beside the checkout |
| `SLYTAB_TEST_HARNESS` | corpus check (writable harness it rsyncs into) | `$HOME/slytab-test` |
| `SLYTAB_CORPUS_CANDIDATES`, `SLYTAB_CORPUS_STATE` | corpus check | in `SLYTAB_STATE_DIR` |
| `SLYTAB_LLM_PROXY_DIR` | corpus check (reads `model`, `backends`) | `/data/stacks/slytab/llm-proxy` |
| `SLYTAB_BACKUP_DIR`, `SLYTAB_BACKUP_DAYS` | backup | `/data/stacks/slytab/backups`, 30 |

The jobs that touch containers send every container call through one
swappable command, so the service account can use a root helper instead of
docker. Unset, each is today's plain `docker` call:

| Variable | Job | Contract |
|---|---|---|
| `SLYTAB_DBDUMP_CMD` | backup | no arguments; plain SQL dump of `slytab_prod` on stdout. The backup's **only** database or container call |
| `SLYTAB_CORPUS_DOCKER_CMD` | corpus check | `start-db` · `gateway` · `run <model> <timeout> <host:port>` (header of `model-corpus-check.sh`) |
| `SLYTAB_NGINX_TEST_CMD`, `SLYTAB_NGINX_RELOAD_CMD` | health check (via `render.sh`) | candidate config on stdin → `nginx -t` status · `nginx -s reload` in `slytab-llm-proxy` |

### Deploying a change to the scheduled jobs

- **Worker scripts** (store-release watcher, corpus check): after the move,
  the scheduled jobs run from the system copy, not from a checkout in anyone's
  home. Update it with
  `sudo git -C /opt/slytab-worker/Splitwise pull --ff-only origin main`
  (`.env` and `secrets/` are gitignored, so a pull leaves them alone). The
  feedback worker's own checkout (`run-worker.sh`, which pulls, commits and
  pushes) is separate and needs to stay writable by the account that runs it.
- **backup.sh / fetch-rates.sh**: `sudo install -o root -g root -m 0755
  scripts/ops/kdocker2/{backup,fetch-rates}.sh /data/stacks/slytab/`.
- **LLM-proxy scripts**: copy `healthcheck.sh` and `render.sh` into
  `/data/stacks/slytab/llm-proxy/` (root-owned once moved).

## How to redeploy

```bash
npm run deploy                # SPA → public_html/slytab (build + UAPI upload)
bash scripts/deploy-api.sh    # API → ~/slytab/api (stage --no-dev, zip, extract,
                              #   config, shim, run migrations, seed rates, health)
```

Both read the repo `.env`. New SQL migrations ship with the API deploy —
`deploy-api.sh` ends by calling the migrate endpoint.

## Restore / rollback

- **Database:** `gunzip < backup.sql.gz | docker exec -i slytab-mysql mysql -uroot -p… slytab_prod` on kdocker2.
- **API code:** re-run `scripts/deploy-api.sh` from any git revision.
- **Tunnel down?** `relay-guard.sh` on kdocker2 self-heals the client and can
  OCI-reset a wedged VM. The API surfaces DB unavailability as 500s until the
  tunnel returns; the SPA still loads.

## Known limits / deliberate choices

- Tunnel adds ~1 RTT (home ↔ Toronto VM ↔ cPanel) per query — fine at family
  scale; BalanceService batches per-group reads.
- MySQL TLS uses the container's self-signed CA (pinned by the API); hostname
  verification is off because we connect by IP.
- The Ollama endpoint behind VM:3308 is unauthenticated; the OCI + iptables
  IP restriction is the only gate (the cPanel egress IP is shared with other
  tenants of that host). Worst case is borrowed inference cycles, not data
  exposure — revisit with an auth proxy if that ever matters.
- If the home connection's IP changes, nothing breaks (kdocker2 dials *out*
  to the VM); only the extra "home IP" debug rules on 3307 go stale.

## Store compliance pages

Two static pages under `apps/web/public/marketing/` ship with `npm run
deploy` and are required by the app stores. Both are referenced from
App Store Connect and the Play Console, so treat their URLs as stable:

| Page | URL | Source | Store field |
|---|---|---|---|
| Privacy policy | `/slytab/marketing/privacy/` | `apps/web/public/marketing/privacy/` | Privacy Policy URL |
| Account & data deletion | `/slytab/marketing/delete-account/` | `apps/web/public/marketing/delete-account/` | Play data-deletion URL |
| Support | `/slytab/marketing/support/` | `apps/web/public/marketing/support/` | **Support URL** (App Store, required) |
| Getting the apps | `/slytab/marketing/apps/` | `apps/web/public/marketing/apps/` | Marketing URL |

The Support URL is a required App Store field and had no page at all — the
apps page was doing duty for it and offers no contact route (issue #86).

Note `/slytab/privacy` also returns 200 — that is the SPA fallback, not the
policy. Always give the stores the `/marketing/` paths.

Both pages describe real behaviour and are checked against it by the
stores: if account deletion, sign-in providers, or what leaves the device
ever change, update these pages **before** shipping the change.

## Store listing artefacts

Generated, gitignored, rebuilt on demand — they are not source:

| Artefact | Where | Notes |
|---|---|---|
| Feature graphic | `SlyTab-play-feature-1024x500.png` | 1024x500, brand palette |
| Play icon | `SlyTab-play-icon-512.png` | exactly 512x512 RGBA — Play rejects other sizes |
| Screenshots | `store-screenshots/*.png` | 1080x1920; Play's max ratio is 2:1, so do NOT use the emulator's native 1440x3040 |
| Play bundle | `SlyTab-<ver>-build<N>.aab` | see docs/private/android-play-setup.md |

Listing copy (short and full description, release notes) lives in
`docs/private/android-play-setup.md`.

## App-association files (invite links)

`bash scripts/ops/publish-applinks.sh` — run after changing them, after an
Android signing-key change, and after any rebuild of the hosting account.

**Not part of `npm run deploy`, and it cannot be.** Apple and Google fetch
these from the **domain root**:

- `https://electricrv.ca/.well-known/apple-app-site-association`
- `https://electricrv.ca/.well-known/assetlinks.json`

The web deploy writes to `public_html/slytab`, so the copy in
`apps/web/public/.well-known/` lands at `/slytab/.well-known/` where nothing
reads it. The script uploads to the root and then checks what the server
actually returns, because three things break universal links silently:

| Failure | Why it bites |
|---|---|
| A redirect | Apple follows none |
| Wrong content type | The AASA has no extension, so the server serves it as nothing at all — an `.htaccess ForceType` is uploaded alongside it |
| Stale Android fingerprint | Read from the **published APK's v2 signing block**, not the keystore, so it matches what users install and needs no password |

## Monitoring

Uptime Kuma on kdocker2 (`http://192.168.10.11:3001`, container
`uptime-kuma`) watches SlyTab under a **SlyTab** group, monitor ids 68–72.
All alert by email through the shared "Email (via Graph bridge)"
notification.

| Monitor | Check | Answers |
|---|---|---|
| `SlyTab · API (liveness)` | `GET /api/v1/health`, keyword `"status":"ok"` | is PHP up? |
| `SlyTab · API → database` | `GET /api/v1/health/deep`, keyword `"database":"ok"` | can the API reach MySQL? |
| `SlyTab · MySQL tunnel (3307)` | TCP `147.5.121.145:3307` | is the tunnel up, seen from the LAN? |
| `SlyTab · Receipt model (ollama)` | `GET :3308/api/tags`, keyword `qwen2.5vl` | is ollama up **and** still holding our model? |

**Read them as a pair.** `/health` deliberately does not touch the
database, so liveness green + deep red means the API host is fine and the
*tunnel* is broken — the distinction nobody could make during the
2026-07-28 outage, when every endpoint timed out and it looked like a dead
web host. The ollama keyword is the model name rather than a bare
reachability check, because receipt scanning broke on 2026-07-27 through an
engine upgrade that a "did it answer" check would have slept through.

Kuma belongs to the SlyClaw project. To change these monitors, follow
`SlyClaw/memory/kuma-host-monitoring.md`: back up `kuma.db` *and* its
`-wal`/`-shm` sidecars, stop the container, and do the whole edit in ONE
`sqlite3` session (`last_insert_rowid()` is per-connection). Pass `-i` to
`docker run` or sqlite3 reads an empty stdin, exits 0, and changes nothing.
