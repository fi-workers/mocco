# Changelog

Records the notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Initial public release (AGPL-3.0). Deploy governance control plane — write ≠ deploy, gate pause/resume, credential gating (design; enforcement ships with the governance phase).
- Next 16 full-stack monorepo (`@mocco/{frontend,backend}`) + Drizzle/Postgres (`@mocco/common` returns with the governance domain).
- Auth: email+password behind a vendor-neutral surface (`authHandler`/`getSession`; the vendor is importable only inside `src/backend/auth/` — lint-enforced).
- Workspace model: `mocco_workspaces`/`mocco_members` with DB-enforced invariants (composite membership uniqueness, case-insensitive slugs, role check, session pointer FK).
- Docker-free integration tests on pglite (WASM Postgres) applying the real migrations.
- CI: supply-chain-hardened GitHub Actions gate (SHA-pinned actions, integrity-pinned yarn, scripts-off install, migration-drift check) — required on `main`.
- llm-wiki documentation system (`docs/` — ADRs, concepts, guides, reference).
