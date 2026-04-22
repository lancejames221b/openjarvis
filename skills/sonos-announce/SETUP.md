# sonos-announce Setup

## Requirements

- `sonos-say` script on your main machine (see below)
- SSH access to the machine running Chatterbox TTS
- Chatterbox TTS running and accessible
- Python 3 for the HTTP audio server (auto-started by script)

## Configuration

Add to your Jarvis `.env`:

```env
SONOS_UP_IP=x.x.x.x        # Upstairs Sonos IP
SONOS_DOWN_IP=x.x.x.x      # Downstairs Sonos IP
SONOS_DEFAULT=down             # Default speaker target
GAMEZ_IP=x.x.x.x           # IP of machine serving audio
GAMEZ_PORT=8765                # Port for audio HTTP server
CHATTERBOX_HOST=your-host      # SSH alias for Chatterbox machine
CHATTERBOX_URL=http://localhost:3340/tts
```

## Install sonos-say script

Save to `~/.local/bin/sonos-say` and `chmod +x`:

```bash
#!/bin/bash
# sonos-say — send a Jarvis TTS message to a Sonos speaker
# Usage: sonos-say <up|down|all> "message"

SPEAKER="${1:-${SONOS_DEFAULT:-down}}"
MESSAGE="${2:-}"

[ -z "$MESSAGE" ] && { echo "Usage: sonos-say <up|down|all> \"message\""; exit 1; }

GAMEZ_IP="${GAMEZ_IP:-}"
GAMEZ_PORT="${GAMEZ_PORT:-8765}"
CHATTERBOX_HOST="${CHATTERBOX_HOST:-}"
CHATTERBOX_URL="${CHATTERBOX_URL:-http://localhost:3340/tts}"
SONOS_UP="${SONOS_UP_IP:-}"
SONOS_DOWN="${SONOS_DOWN_IP:-}"
AUDIO_FILE=/tmp/sonos-say.wav

# Generate TTS via Chatterbox
ssh "$CHATTERBOX_HOST" "curl -s -X POST $CHATTERBOX_URL \
  -H 'Content-Type: application/json' \
  -d '{\"text\": \"$MESSAGE\", \"voice\": \"jarvis\"}' \
  -o $AUDIO_FILE" 2>/dev/null

scp -q "$CHATTERBOX_HOST:$AUDIO_FILE" "$AUDIO_FILE" 2>/dev/null

# Ensure HTTP server is running
pgrep -f "http.server $GAMEZ_PORT" > /dev/null || \
  python3 -m http.server "$GAMEZ_PORT" --directory /tmp &>/dev/null &
sleep 1

play_on_sonos() {
  local IP="$1"
  curl -s "http://$IP:1400/MediaRenderer/AVTransport/Control" \
    -H 'Content-Type: text/xml' \
    -H "SOAPAction: \"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\"" \
    -d "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>http://$GAMEZ_IP:$GAMEZ_PORT/sonos-say.wav</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>" > /dev/null
  curl -s "http://$IP:1400/MediaRenderer/AVTransport/Control" \
    -H 'Content-Type: text/xml' \
    -H "SOAPAction: \"urn:schemas-upnp-org:service:AVTransport:1#Play\"" \
    -d '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>' > /dev/null
}

case "$SPEAKER" in
  up)   play_on_sonos "$SONOS_UP";   echo "Playing upstairs" ;;
  down) play_on_sonos "$SONOS_DOWN"; echo "Playing downstairs" ;;
  all)  play_on_sonos "$SONOS_UP"; play_on_sonos "$SONOS_DOWN"; echo "Playing on all speakers" ;;
  *)    echo "Unknown speaker: $SPEAKER. Use up, down, or all."; exit 1 ;;
esac
```

## Finding Sonos IPs

```bash
nmap -sn x.x.x.0/24 | grep -i sonos -A1
# or query each candidate:
curl -s http://CANDIDATE_IP:1400/xml/device_description.xml | grep roomName
```

## Testing

```bash
sonos-say down "This is a test announcement."
sonos-say up "Testing the upstairs speaker."
sonos-say all "Testing all speakers."
```
