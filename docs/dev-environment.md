# SlyTab — Local Development Environment

**Date:** 2026-07-22 · **Status:** Set up and verified on the dev machine
(WSL2 + Docker Desktop) and kdocker2.

Nothing is installed natively except Node 22: PHP runs in local containers,
MySQL runs on the always-on Docker host. This mirrors production shape
(PHP 8.2 + MySQL 8) without touching the WSL install.

## The pieces

| Piece | Where | How |
|---|---|---|
| Node 22 / npm | WSL native | already installed |
| PHP 8.2 + Composer | Local Docker Desktop containers (`php:8.2-cli`, `composer:2`) | wrapped by npm scripts, no local install |
| MySQL 8.4 | `slytab-mysql` container on **kdocker2** (`192.168.10.11:3306`) | persistent volume `slytab-mysql-data`, `--restart unless-stopped` |
| Credentials | gitignored root `.env` (`DB_*`) | generated at container creation; chmod 600 |

kdocker2 is reachable as `ssh kdocker2` from the dev machine. If direct SSH
fails (e.g. from another network segment), double-hop through `kdocker`
(`ssh -J kdocker kdocker2`).

## Daily commands

```bash
npm run dev           # PHP API container on :8100 + Vite on :8000
npm run test          # Vitest — core money math + shared vectors
npm run test:php      # PHPUnit in php:8.2 container — TS/PHP parity gate
npm run php:install   # composer install (after changing api/composer.json)
```

The Vite dev server proxies `/api` → `127.0.0.1:8100`, so the web app talks
to the containerized API transparently.

## Database

- Dev database: `slytab_dev`, user `slytab` (password in `.env`;
  root password in `.env` as `DB_ROOT_PASS`).
- Schema v1 (`api/src/Db/migrations/001_init.sql`) is applied and verified —
  13 tables, `schema_migrations` at version 1.
- Apply a new migration:

```bash
set -a; . ./.env; set +a
ssh kdocker2 "docker exec -i -e MYSQL_PWD='$DB_PASS' slytab-mysql \
  mysql -uslytab slytab_dev" < api/src/Db/migrations/NNN_name.sql
```

- Reset the dev database completely:

```bash
ssh kdocker2 'docker rm -f slytab-mysql && docker volume rm slytab-mysql-data'
# then re-create the container (new passwords → update .env) and re-apply
# migrations in order
```

## Verified working (2026-07-22)

- `mysql:8.4` container up on kdocker2, schema v1 applied.
- `composer install` + PHPUnit green in `php:8.2-cli` (17 tests — the same
  shared vectors Vitest runs).
- `GET /api/v1/health` → `{"status":"ok","service":"slytab-api","schemaVersion":1}`
  from the containerized Slim app.

## Notes & gotchas

- The repo lives on `/mnt/d` (Windows drive): container bind mounts work
  through Docker Desktop's WSL integration but file I/O is slower than
  native — fine at this project size.
- `sudo` in WSL prompts for a password, which is why nothing is apt-installed;
  if you ever want native PHP: `sudo apt install php8.2-cli php8.2-mysql composer`.
- The API doesn't read `DB_*` yet (health route only) — the DB wiring lands
  with the auth slice.
