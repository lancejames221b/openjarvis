#!/bin/bash
# Test the alert webhook endpoint

# Get config from .env
TOKEN=$(grep ALERT_WEBHOOK_TOKEN /home/generic/dev/jarvis-voice/.env | cut -d '=' -f2)
PORT=$(grep ALERT_WEBHOOK_PORT /home/generic/dev/jarvis-voice/.env | cut -d '=' -f2)
TAILSCALE_IP=$(grep TAILSCALE_IP /home/generic/dev/jarvis-voice/.env | cut -d '=' -f2)

echo "Testing alert webhook at $TAILSCALE_IP:$PORT (Tailscale only)..."
echo ""

curl -X POST http://$TAILSCALE_IP:$PORT/alert \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "eWitness detected Wells Fargo phishing attempt",
    "priority": "urgent",
    "fullDetails": "eWitness security monitor detected a potential Wells Fargo phishing campaign. Multiple new domains were registered in the last hour matching known phishing patterns. Recommend immediate investigation.",
    "source": "security-monitor"
  }'

echo ""
echo ""
echo "Alert sent! Check bot logs and Discord DM."
