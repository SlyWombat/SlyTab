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
                                             → 127.0.0.1:3306 → slytab-mysql container
                                               └ db slytab_prod, user slytab_prod REQUIRE SSL
```

## Key facts

| Piece | Where / value |
|---|---|
| API base | `https://electricrv.ca/slytab/api/v1` (Slim basePath `/slytab`) |
| Admin endpoints | `POST /slytab/api/internal/{migrate,fetch-rates}` with `X-Admin-Token` |
| Prod DB | `slytab_prod` on kdocker2's `slytab-mysql`, via VM `147.5.121.145:3307`, TLS required, CA pinned (`scripts/prod/mysql-ca.pem` — public cert) |
| Secrets | Local repo `.env` holds `CPANEL_*`, `WEB_ROOT`, and all `PROD_*` values; the host's copy lives in `~/slytab/config.env` (0644, above web root) |
| Receipt scanning | Disabled until `ANTHROPIC_API_KEY` is set in `~/slytab/config.env` (endpoint returns a clear 503 meanwhile) |
| Rathole configs | VM `/etc/rathole/server.toml` (systemd `rathole-server`); kdocker2 `/data/stacks/tesla-log/relay/client.toml` (`tesla-relay-client`, watched by `relay-guard.sh`) — both have `.bak` copies from before the SlyTab service was added |
| OCI | Port 3307 opened in the VM's security list ("SlyTab MySQL tunnel" rules); backup of prior rules at kdocker2 `/tmp/sl-ingress-backup.json` |

## Recurring jobs (cron on kdocker2 — always on, no cPanel cron needed)

```
20 3 * * * /data/stacks/slytab/backup.sh       # mysqldump slytab_prod → backups/, 30-day retention
10 6 * * * /data/stacks/slytab/fetch-rates.sh  # POST /api/internal/fetch-rates (ECB rates)
```

Secrets for both live in `/data/stacks/slytab/cron.env` (0600).

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
- If the home connection's IP changes, nothing breaks (kdocker2 dials *out*
  to the VM); only the extra "home IP" debug rules on 3307 go stale.
