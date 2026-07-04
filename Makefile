.PHONY: help initialize application certs hosts dev run-frontend run-traefik docker-up docker-down docker-logs migrate lint test

help: ## List commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

initialize: certs ## First-time setup (certs + hosts + install)
	@sudo ./infra/local/scripts/hosts.sh
	@corepack enable && yarn install

application: ## Install local tools (brew)
	@brew install mkcert nss traefik node corepack || true

certs: ## mkcert local TLS certificates (mocco.work)
	@mkcert -install
	@mkdir -p infra/local/cert
	@cd infra/local/cert && mkcert mocco.work '*.mocco.work'

hosts: ## Register /etc/hosts (sudo)
	@sudo ./infra/local/scripts/hosts.sh

dev: ## Development server (frontend + traefik)
	@yarn dev

run-frontend: ; @yarn frontend dev
run-traefik: ; @cd infra/local/traefik && traefik --configFile=traefik.toml

docker-up: ## Start local Postgres
	@docker compose up -d postgres
docker-down: ; @docker compose down
docker-logs: ; @docker compose logs -f
migrate: ## DB migration
	@yarn db:migrate
lint: ; @yarn lint
test: ; @yarn test
