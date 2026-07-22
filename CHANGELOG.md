# Changelog

All notable changes to SlySplit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial project documentation: requirements, architecture, design
  specification, and UI requirements (2026-07-22).
- Brand identity: "split coin" logo mark, app icon master, and light/dark
  wordmarks in `assets/brand/`; brand usage rules in
  `docs/design/DESIGN.md` §2 (2026-07-22).
- High-fidelity UI mockups (`docs/design/mockups.html`) covering Home,
  Group balances, Add expense, Receipt assignment, and Settle up
  (2026-07-22).

### Changed

- Architecture §3.1: verified via cPanel UAPI that the electricrv.ca host
  has **no Passenger/Node.js support** but **does** offer MySQL. Backend
  decision now Option A (PHP 8 + MySQL on cPanel, recommended) vs Option B
  (Node on a VPS) (2026-07-22).
- **Backend decided: Option A — PHP 8.2 (Slim 4) + MySQL on cPanel.**
  Architecture, README, requirements, and contributing docs updated:
  `server/` (Node/Fastify/SQLite) replaced by `api/` (PHP/PDO/MySQL), wire
  contract single-sourced from the Zod schemas via generated JSON Schema,
  money-math parity enforced by a shared test-vector suite (Vitest +
  PHPUnit) (2026-07-22).
