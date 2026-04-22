# speaker-route Setup

## Requirements

- `sonos-say` script installed at `~/.local/bin/sonos-say` (from sonos-announce skill)
- Sonos speakers configured with `SONOS_UP_IP` and `SONOS_DOWN_IP` in `.env`
- Chatterbox TTS running on `CHATTERBOX_HOST`

No additional setup needed beyond the sonos-announce skill.

## How It Works

Jarvis listens via Discord on your phone as normal. When speaker-route is active, the response text is also piped through `sonos-say` so it plays on whichever Sonos speaker you chose.

The persistent mode is stored in `/tmp/jarvis-speaker-mode` — it resets on reboot, which is intentional (you don't want speaker mode left on forever).

## Testing

```bash
# Test one-shot routing
sonos-say down "This is a test of speaker routing."

# Test speaker mode
echo "down" > /tmp/jarvis-speaker-mode
cat /tmp/jarvis-speaker-mode    # should print: down
rm /tmp/jarvis-speaker-mode     # turn it off
```
