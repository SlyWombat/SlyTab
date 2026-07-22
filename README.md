# SlyTab

**Split expenses with the people you actually share life with.**

SlyTab tracks who paid for what and who owes whom — for households, trips,
and friend groups. Snap a receipt and let it itemize itself, split in any
currency, and settle up with a single tap. No ads, no analytics, no selling
your data.

🌐 Web app: [electricrv.ca/slytab](https://electricrv.ca/slytab)
📱 iOS and Android apps built with React Native + Expo.

## Features

- **Groups for everything** — a household, a trip, a couple. A "friend" is just
  a two-person group; balances roll up the same way everywhere.
- **Any split you need** — equal, exact amounts, shares, percentages, or
  adjustments ("+$10 because Dave got the steak").
- **Receipt scanning** — photograph a receipt; SlyTab itemizes it with the
  Claude API and lets you drag items to people. Tax and tip prorate
  automatically.
- **Multi-currency** — every expense carries its own currency; balances convert
  to the group's home currency using the exchange rate locked on the expense
  date (ECB daily rates).
- **Debt simplification** — five people, twenty expenses, minimum number of
  transfers to settle everyone up.
- **Settle up without a middleman** — SlyTab never holds money. It records
  settlements and deep-links to how each person likes to be paid: Interac
  e-Transfer, PayPal.Me, or Venmo.
- **Private by design** — no telemetry, no analytics SDKs, no third-party
  trackers. Your data lives on our server in Canada and nowhere else.

## Documentation

- [Requirements](docs/requirements.md) — what v1.0 does (and deliberately doesn't)
- [Architecture](docs/architecture.md) — stack, data model, API, deployment
- [Design specification](docs/design/DESIGN.md) — design language and tokens
- [UI requirements](docs/design/ui_requirements.md) — every screen and flow

## Stack

TypeScript clients, PHP server. React 19 + Vite web SPA and React Native +
Expo mobile apps share one TypeScript core package (split math, currency,
Zod schemas); a small PHP 8 + MySQL REST API runs natively on the same
cPanel host that serves the site — no extra infrastructure. The PHP money
math is kept provably identical to the TypeScript core by a shared
test-vector suite run in CI by both Vitest and PHPUnit. Deployed to
electricrv.ca with the same UAPI upload tooling as
[CaseMaker](https://github.com/SlyWombat/CaseMaker). Receipt parsing is the
only external service call, made server-side to the Claude API.

## Run it locally

```bash
git clone https://github.com/SlyWombat/SlyTab.git
cd SlyTab
npm ci && composer install -d api
npm run dev          # PHP API (php -S :8100) + web app (:8000)
npm run dev:mobile   # Expo dev server for the mobile app
```

## Status

Pre-1.0 — design phase. See [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
