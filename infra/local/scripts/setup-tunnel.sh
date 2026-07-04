#!/bin/bash
set -e
TUNNEL_NAME="mocco-local"
DOMAIN="dev.mocco.work"   # public URL so GitHub webhooks/OIDC callbacks can reach local
PORT="3100"

command -v cloudflared >/dev/null || { echo "cloudflared required: brew install cloudflared"; exit 1; }
cloudflared tunnel list >/dev/null 2>&1 || cloudflared tunnel login

if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
  echo "tunnel '$TUNNEL_NAME' already exists"
  TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
else
  TUNNEL_ID=$(cloudflared tunnel create "$TUNNEL_NAME" | grep "Created tunnel" | awk '{print $4}')
fi

mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/mocco.yml" <<CFG
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $DOMAIN
    service: http://localhost:$PORT
  - service: http_status:404
CFG
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>/dev/null || echo "DNS route already exists/failed"
echo "Done. Run: cloudflared tunnel --config \$HOME/.cloudflared/mocco.yml run $TUNNEL_NAME"
echo "Webhook URL: https://$DOMAIN/api/webhooks/github"
