.PHONY: help initialize application certs hosts tunnel dev run-frontend run-traefik run-tunnel docker-up docker-down docker-logs migrate lint test

help: ## List commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

initialize: certs ## First-time setup (certs + hosts + tunnel + install)
	@sudo ./infra/local/scripts/hosts.sh
	@./infra/local/scripts/setup-tunnel.sh || true
	@corepack enable && yarn install

application: ## Install local tools (brew)
	@brew install mkcert nss traefik cloudflared node corepack || true

certs: ## mkcert local TLS certificates (mocco.work)
	@mkcert -install
	@mkdir -p infra/local/cert
	@cd infra/local/cert && mkcert mocco.work '*.mocco.work'

hosts: ## Register /etc/hosts (sudo)
	@sudo ./infra/local/scripts/hosts.sh

tunnel: ## Set up cloudflared tunnel (dev.mocco.work, webhook/OIDC)
	@./infra/local/scripts/setup-tunnel.sh

dev: ## Development server (frontend + traefik)
	@yarn dev

run-frontend: ; @yarn frontend dev
run-traefik: ; @cd infra/local/traefik && traefik --configFile=traefik.toml
run-tunnel: ; @cloudflared tunnel --config $$HOME/.cloudflared/mocco.yml run mocco-local

docker-up: ## Start local Postgres
	@docker compose up -d postgres
docker-down: ; @docker compose down
docker-logs: ; @docker compose logs -f
migrate: ## DB migration
	@yarn db:migrate
lint: ; @yarn lint
test: ; @yarn test
