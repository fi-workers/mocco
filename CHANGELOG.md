# Changelog

Records the notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Initial public release (AGPL-3.0). Deploy governance control plane — write ≠ deploy, gate pause/resume, credential gating.
- Next 16 full-stack monorepo (`@mocco/{frontend,backend,common}`) + Drizzle/Postgres + Better Auth (GitHub OAuth, organization plugin).
- Docker-free integration test infrastructure based on pglite (WASM Postgres).
- tRPC auth context (`protectedProcedure`) + `session.me`.
- HTML click-through prototype (`docs/prototype/` — for validating the product design; non-functional).
- llm-wiki documentation system (`docs/` — ADR, reference, guides).
