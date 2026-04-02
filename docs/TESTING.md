# Testing Jarvis Voice

## Quick Start

### 1. Check Service Status

```bash
sudo systemctl status jarvis-voice
```

Should show: **Active: active (running)**

### 2. View Live Logs

```bash
sudo journalctl -u jarvis-voice.service -f
```

Watch for:
- `🎤 Connected to Discord as JarvisVoice#1234`
- `🔊 Bot joined voice channel in YourServer`
- `🎙️ Listening for audio...`

### 3. Join Discord Voice Channel

1. Open Discord
2. Join the voice channel where Jarvis is
3. You should see the bot in the channel

### 4. Test Wake Word (If Enabled)

**First message:** "Jarvis, what time is it?"

Expected response (via voice):
> "Good morning, sir. It's eleven thirty AM. The weather in New York is sixty five degrees with clear skies."

**Follow-up (within 60s):** "What about London?"

Expected response:
> "Currently fifty two degrees Fahrenheit in London, with partly cloudy conditions."

### 5. Test Without Wake Word (If Disabled)

Set `WAKE_WORD_ENABLED=false` in `.env`, restart:

```bash
sudo systemctl restart jarvis-voice
```

Then just talk normally — no "Jarvis" needed.

## Test Cases

### Basic Acknowledgments

| Input | Expected Voice Output |
|-------|----------------------|
| "Jarvis, are you there?" | "At your service, sir." |
| "Jarvis, are you up?" | "For you sir, always." |
| "Hey Jarvis, status report" | Natural status update with "sir" |

### Information Retrieval

| Input | Expected Behavior |
|-------|------------------|
| "Jarvis, what's the weather?" | Uses web search, reports current weather |
| "Check my email" | Uses google-workspace MCP, reads recent emails |
| "What's on my calendar?" | Uses google-workspace MCP, lists events |
| "Search for Opus updates" | Uses web search, summarizes findings |

### Tool Usage

| Input | Expected Behavior |
|-------|------------------|
| "Post to Slack" | Uses message tool, confirms "Done, sir. Posted to Slack." |
| "Create a reminder" | Uses cron tool, confirms "Reminder set for..." |
| "Search haivemind for X" | Uses mcporter, reports findings |

### Character Consistency

| Input | Expected Voice Style |
|-------|---------------------|
| "That looks ridiculous" | "Little ostentatious, don't you think?" |
| "Do it anyway" | "As you wish, sir. Though I feel compelled to note this is inadvisable." |
| "Good job" | "A very astute observation, sir." |

### Barge-In (Interruption)

1. Ask a long question: "Jarvis, tell me about the history of artificial intelligence"
2. Wait for the bot to start speaking
3. Interrupt by talking for >1.5s continuously
4. Expected: Bot stops speaking, listens to your new input

## Debugging

### Bot Joins But Doesn't Respond

**Check:** Wake word enabled but not being said

```bash
grep WAKE_WORD_ENABLED ./jarvis-voice/.env
```

Should be `true` → say "Jarvis" at start of message
Should be `false` → just talk normally

**Check:** Your user ID in allowed list

```bash
grep ALLOWED_USERS ./jarvis-voice/.env
```

Should include your Discord user ID.

### Audio Quality Issues

**Check:** Edge TTS voice configured

```bash
grep EDGE_TTS_VOICE ./jarvis-voice/.env
```

Should be: `en-GB-RyanNeural`

**Test:** Edge TTS installation

```bash
~/.local/bin/edge-tts --voice en-GB-RyanNeural --text "At your service, sir." --write-media /tmp/test.mp3
mpv /tmp/test.mp3
```

### Gateway Connection Issues

**Check:** Clawdbot gateway is running

```bash
clawdbot status
```

**Check:** Gateway URL in .env

```bash
grep CLAWDBOT_GATEWAY_URL ./jarvis-voice/.env
```

Should be: `http://127.0.0.1:22100`

**Test:** Gateway health endpoint

```bash
curl http://127.0.0.1:22100/health
```

### No Voice Output

**Check:** Streaming TTS enabled

```bash
grep STREAMING_TTS_ENABLED ./jarvis-voice/.env
```

Should be: `true`

**Check logs for TTS errors:**

```bash
sudo journalctl -u jarvis-voice.service -n 100 | grep -i "tts\|audio\|speak"
```

## Performance Metrics

### Expected Latencies

- **STT (Whisper API):** ~1-2s for 5s of speech
- **Brain (Clawdbot):** ~1-3s for simple queries, 3-6s for complex tool use
- **TTS (Edge):** ~0.5-1s per sentence
- **First audio:** ~2s from end of speech
- **Total interaction:** ~3-5s for simple queries

### Cost Per Interaction

- **STT:** $0.006/min → ~$0.0005 per 5s utterance
- **TTS:** FREE (Edge TTS)
- **Brain:** Included in Clawdbot/Claude subscription
- **Total:** ~$0.0005 per interaction

## Live Testing Checklist

- [ ] Service is running (`systemctl status`)
- [ ] Bot connected to Discord (logs show "Connected")
- [ ] Wake word works or is disabled intentionally
- [ ] Voice responses are clear and natural
- [ ] Jarvis persona is consistent (British, warm, professional)
- [ ] Tools work (web search, email, calendar, MCP)
- [ ] Barge-in/interruption works
- [ ] Conversation window works (no wake word needed within 60s)
- [ ] Multi-turn conversations flow naturally
- [ ] No audio glitches or overlaps

## Next Steps After Testing

1. **Tune response style** — adjust voice prefix if responses feel off
2. **Adjust TTS voice** — try different Edge voices if needed
3. **Optimize wake word** — adjust phrases or disable if not needed
4. **Performance tuning** — monitor latencies, optimize slow paths
5. **Add shortcuts** — create voice command shortcuts for common tasks
6. **Context awareness** — enhance conversation memory across sessions

## Example Session

```
You: "Jarvis, are you there?"
Bot: "At your service, sir."

You: "What's the weather in New York?"
Bot: "Currently sixty five degrees Fahrenheit in New York, with clear skies. High today of seventy two."

You: "Check my email"
Bot: "You have three unread messages, sir. Most recent from Rhodey at ten forty two AM regarding the board meeting."

You: "Post an update to Slack"
Bot: "Certainly, sir. What would you like me to post?"

You: "Tell the team the meeting is at 2 PM"
Bot: "Done, sir. Posted to Slack general channel."
```

This is the target experience — natural, responsive, authentic to the Jarvis character.
