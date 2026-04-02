# Jarvis Voice Alert System

Two-stage alert system that sends text notifications when you're away and delivers voice briefings when you return to voice.

## How It Works

### Stage 1: Alert Received (You're Not in Voice)
1. External system (security monitor, cron job, etc.) sends alert via HTTP webhook
2. Alert is queued in memory
3. **Discord DM sent immediately:** "🚨 Urgent Alert: [message]. Join voice for briefing."

### Stage 2: You Join Voice
1. Jarvis detects you joining the voice channel
2. Immediately briefs you: "Welcome back. Urgent alert from 3 minutes ago: [summary]. Want the rundown?"
3. If you say "yes" → Full details spoken aloud
4. Alerts cleared after briefing

## Configuration

Add to `.env`:
```bash
***REMOVED*** - webhook binds to this address only (not exposed publicly)
TAILSCALE_IP=your.tailscale.ip
ALERT_WEBHOOK_PORT=3335
ALERT_WEBHOOK_TOKEN=your-secure-token-here
```

**Security:** 
- The webhook binds to Tailscale IP only — not exposed to the public internet
- Requires Bearer token authentication — only requests with valid tokens can queue alerts

## Usage

### Sending Alerts

**HTTP POST to webhook:**
```bash
curl -X POST http://your.tailscale.ip:3335/alert \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Brief summary for voice briefing",
    "priority": "urgent",
    "fullDetails": "Full context (optional) - spoken if user asks",
    "source": "security-monitor"
  }'
```

**Note:** Replace `your.tailscale.ip` with your actual Tailscale IP.

**Fields:**
- `message` (required): Brief summary for initial briefing (keep under 20 words)
- `priority` (optional): `urgent` or `normal` (default: `normal`)
- `fullDetails` (optional): Full context spoken when user says "yes, tell me more"
- `source` (optional): Source identifier (e.g., `security-monitor`, `cron`, `system`)

**Priority handling:**
- `urgent` alerts spoken first
- Within same priority, oldest first
- Discord DM shows 🚨 for urgent, 🔔 for normal

### Testing

Run the test script:
```bash
./test-alert.sh
```

This sends a test alert. If you're not in voice, you'll receive a Discord DM. Join voice to hear the briefing.

### Integration Examples

**From a security monitoring script:**
```bash
#!/bin/bash
# security-monitor.sh

ALERT_URL="http://localhost:3335/alert"
ALERT_TOKEN="your-token"

# Detect threat
if [[ $THREAT_DETECTED == "true" ]]; then
  curl -X POST "$ALERT_URL" \
    -H "Authorization: Bearer $ALERT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"message\": \"$THREAT_SUMMARY\",
      \"priority\": \"urgent\",
      \"fullDetails\": \"$FULL_REPORT\",
      \"source\": \"security-monitor\"
    }"
fi
```

**From a cron job:**
```bash
# Daily backup status alert
0 8 * * * curl -X POST http://localhost:3335/alert \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "Daily backups completed successfully", "priority": "normal", "source": "cron"}'
```

**From Python:**
```python
import requests

def send_jarvis_alert(message, priority='normal', details=None, source='script'):
    url = 'http://localhost:3335/alert'
    headers = {
        'Authorization': 'Bearer your-token',
        'Content-Type': 'application/json'
    }
    payload = {
        'message': message,
        'priority': priority,
        'fullDetails': details,
        'source': source
    }
    
    response = requests.post(url, json=payload, headers=headers)
    return response.json()

# Usage
send_jarvis_alert(
    message="High memory usage detected on prod-server-01",
    priority="urgent",
    details="Memory usage has exceeded 90% threshold for the past 10 minutes. Current: 94%. Top processes: nginx, postgres, redis.",
    source="monitoring"
)
```

## Voice Commands

When Jarvis briefs you on pending alerts:
- **"Yes"** / **"Tell me more"** / **"Give me the rundown"** → Speaks full details
- **"No"** / **"Later"** → Alerts remain queued (will re-brief next time you join)

## Architecture

**Files:**
- `src/alert-queue.js` — In-memory alert queue with priority sorting
- `src/alert-webhook.js` — HTTP server for external alerts + text notification sender
- `src/index.js` — Voice state detection + briefing handler

**Flow:**
1. Webhook receives alert → queues it
2. If user not in voice → sends Discord DM
3. User joins voice → `voiceStateUpdate` event fires
4. Bot detects User joined → checks `hasPendingAlerts()`
5. If alerts exist → calls `briefPendingAlerts(userId)`
6. Briefing synthesized + spoken
7. Conversation context stores alerts for follow-up
8. User responds "yes" → full details spoken → alerts cleared

## Self-Mute Queue Interaction

When `MUTE_QUEUE_ENABLED=true`, alerts that arrive while the owner is self-muted are captured by the mute queue instead of being spoken or queued to the standard alert system:

- **`/speak` callbacks** — intercepted at `setSpeakCallback()`, text added to mute queue
- **`/alert` calls** — if delivered via voice path (`speakCallback`), intercepted by the mute queue
- **In-flight task responses** — intercepted at `flushToPipeline()` before TTS synthesis

On unmute, the mute queue debrief takes priority. Alerts queued via the standard `alert-queue.js` (e.g. while user was out of voice entirely) are briefed separately after the mute queue debrief if both exist.

The mute queue and alert queue serve different scenarios:
- **Alert queue** (`alert-queue.js`): user is **out of voice** — alerts wait for channel join
- **Mute queue** (`mute-queue.js`): user is **in voice but self-muted** — output waits for unmute

## Limitations & Future Enhancements

**Current limitations:**
- Alerts stored in memory only (lost on bot restart)
- No per-alert acknowledgment (all cleared after briefing)
- Single user only (hardcoded to `ALLOWED_USERS[0]`)

**Planned enhancements:**
- Persist alerts to JSON file (survive restarts)
- Multiple priority levels (critical/urgent/normal/info)
- Per-alert actions: "dismiss the first one", "snooze for 1 hour"
- Integration with existing YourOrg security monitoring
- Multi-user support with per-user alert queues
- WhatsApp notification fallback (if no Discord DM)

## Health Check

Verify webhook is running:
```bash
curl http://localhost:3335/health
# {"ok":true,"service":"jarvis-voice-alerts"}
```

## Troubleshooting

**"Unauthorized" error:**
- Check `ALERT_WEBHOOK_TOKEN` matches in both `.env` and your request
- Verify `Authorization: Bearer <token>` header is present

**No Discord DM received:**
- Check bot logs for "📱 Text notification sent"
- Verify you have DMs enabled from server members
- Ensure bot has permission to send DMs (check Discord settings)

**Alert spoken but "full details" not working:**
- Check `fullDetails` field is present in webhook payload
- Verify wake word detection is working (say "Jarvis, yes")
- Look for "📢 Alert briefing follow-up detected" in logs

**Alerts not triggering on voice join:**
- Check `voiceStateUpdate` event is firing (look for "👋 User joined voice channel")
- Verify `currentVoiceChannelId` matches the channel you're joining
- Ensure alerts are actually queued (check "📬 Alert queued" in logs)
