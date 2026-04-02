#!/bin/bash
# Test the alert webhook endpoint
# Reads config from .env — no hardcoded values

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE"
  echo "Usage: ENV_FILE=/path/to/.env bash test-alert.sh"
  exit 1
fi

TOKEN=$(grep "^ALERT_WEBHOOK_TOKEN=" "$ENV_FILE" | cut -d '=' -f2)
PORT=$(grep "^ALERT_WEBHOOK_PORT=" "$ENV_FILE" | cut -d '=' -f2 || echo "3335")
HOST=$(grep "^ALERT_WEBHOOK_HOST=" "$ENV_FILE" | cut -d '=' -f2 || echo "localhost")
TAILSCALE_IP=$(grep "^TAILSCALE_IP=" "$ENV_FILE" | cut -d '=' -f2)

# Use TAILSCALE_IP if set, otherwise fall back to ALERT_WEBHOOK_HOST or localhost
TARGET_HOST="${TAILSCALE_IP:-${HOST:-localhost}}"
PORT="${PORT:-3335}"

echo "Testing alert webhook at $TARGET_HOST:$PORT..."
echo ""

curl -X POST "http://$TARGET_HOST:$PORT/alert" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test alert from test-alert.sh",
    "priority": "urgent",
    "fullDetails": "This is a test alert to verify the webhook endpoint is working correctly.",
    "source": "test"
  }'

echo ""
echo ""
echo "Alert sent. Check bot logs and Discord."
