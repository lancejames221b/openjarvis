# Deepgram Setup - Faster STT

## Sign Up (Free Tier)

1. Go to https://console.deepgram.com/signup
2. Sign up with email (or GitHub)
3. Free tier includes: **$200 credit (45 hours of audio)**

## Get API Key

1. Go to https://console.deepgram.com/project/default/keys
2. Click "Create a New API Key"
3. Copy the key

## Add to .env

```bash
# Add to ./jarvis-voice/.env
DEEPGRAM_API_KEY=your_key_here
STT_PROVIDER=deepgram
```

## Restart Service

```bash
sudo systemctl restart jarvis-voice
```

## Verify

Check logs for "Deepgram" instead of "Whisper":

```bash
sudo journalctl -u jarvis-voice.service -f
```

You should see faster transcription times (~500ms instead of 2-3s).

## Cost Comparison

- **Deepgram:** $0.0043/min → $0.00036 per 5s interaction
- **Whisper:** $0.006/min → $0.0005 per 5s interaction

Deepgram is **28% cheaper** and **4x faster**.
