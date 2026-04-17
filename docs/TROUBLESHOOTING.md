# Troubleshooting

## Gateway is down / not responding

```bash
systemctl --user status jarvis-gateway
journalctl --user -u jarvis-gateway -n 50
```

**"Claude CLI not found or not executable"**: Install the claude CLI from [claude.ai/code](https://claude.ai/code) and ensure `~/.local/bin/claude` is executable. Or set `CLAUDE_BIN=/full/path/to/claude` in `.env`.

**"Not logged in"**: Run `claude login` as the same user that runs the gateway service.

**Port conflict**: Check `ss -tlnp | grep 22100`. If something else is using the port, set `ZEROCLAW_COMPAT_PORT=<other>` in `.env` and update `JARVIS_GATEWAY_URL` to match.

---

## Claude login expired

The OAuth token stored in `~/.claude/.credentials.json` has a limited lifetime. Signs:
- Gateway logs show `"Not logged in"` or `401` errors
- `claude -p "hi"` returns an auth error in terminal

Fix:
```bash
claude login
systemctl --user restart jarvis-gateway
```

---

## STT (speech recognition) not working

```bash
journalctl --user -u jarvis-voice -n 50 | grep -i stt
```

**faster-whisper**: Check the Whisper service is running:
```bash
systemctl --user status jarvis-whisper-stt
curl -s http://localhost:8766/health
```
If not running: `systemctl --user start jarvis-whisper-stt`

**Deepgram**: Verify `DEEPGRAM_API_KEY` is set and the account has credits.

**MLX Whisper**: Verify your Mac is reachable at `MLX_WHISPER_URL` and the service is running on the Mac.

**Fallback**: Set `STT_PROVIDER=whisper` to use the local Whisper CLI (no GPU service needed, slower).

---

## TTS (voice output) not working

```bash
journalctl --user -u jarvis-voice -n 50 | grep -i tts
```

**Piper**: Verify the Piper service started:
```bash
curl -s http://localhost:3336/health
```
Set `PIPER_ENABLED=false` to fall back to Edge TTS (Microsoft Neural, cloud).

**Edge TTS**: Verify `~/.local/bin/edge-tts` exists (install: `pip install edge-tts`).

**No audio in Discord**: Check the bot has "Speak" permission in the voice channel.

---

## Bot joins but doesn't respond

1. Check `ALLOWED_USERS` includes your Discord user ID
2. Check `DISCORD_VOICE_CHANNEL_ID` is correct (right-click channel → Copy ID)
3. Check wake word if `VOICE_WAKE_WORD_ENABLED=true` — say "Jarvis, [command]"
4. Check gateway health: `curl -s http://127.0.0.1:22100/health`

---

## High latency / slow responses

Normal response time is ~3-5s for a short query. Factors:

- **First request after restart**: Cold start includes Claude CLI initialization (~1s)
- **MCP server loading**: Disabled by default; check `BASE_ARGS` in `scripts/jarvis-gateway.js`
- **Model selection**: `claude-opus-4-7` (deep) is slower than `claude-sonnet-4-6` (default)
- **Piper TTS cold start**: First synthesis takes ~1s longer on a cold model

```bash
# Check gateway response time
time curl -s -X POST http://127.0.0.1:22100/v1/chat/completions \
  -H "Authorization: Bearer $JARVIS_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

---

## Memory store ("remember X") not working

Check haivemind is running:
```bash
curl -s http://127.0.0.1:8900/health
journalctl --user -u jarvis-gateway | grep memory_stor
```

If `memory_store_failed`: haivemind may not be running or the port is wrong. Set `HAIVEMIND_URL=http://127.0.0.1:<port>` in `.env`.

---

## Checking all service status at once

```bash
for svc in jarvis-gateway jarvis-voice jarvis-whisper-stt jarvis-piper-tts; do
  echo "=== $svc ===" && systemctl --user is-active $svc
done
```
