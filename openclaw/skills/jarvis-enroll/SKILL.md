---
name: jarvis-enroll
description: Interactive voiceprint enrollment for Jarvis Voice. Guides the user through enrolling their voice so only they can command Jarvis. Use when someone says enroll my voice, set up voiceprint, train Jarvis to recognize me, or voice enrollment.
model: sonnet-high
triggers:
  - "enroll my voice"
  - "set up voiceprint"
  - "train Jarvis to recognize me"
  - "voice enrollment"
  - "voice auth"
  - "set up voice authentication"
  - "Jarvis doesn't recognize my voice"
---

# jarvis-enroll — Voiceprint Enrollment

Guide the user through enrolling their voice so Jarvis will only respond to them.

## Why This Matters

Without voiceprint auth, anyone who can hear Jarvis (spouse, roommate, TV, conference call) can give commands. With enrollment, Jarvis uses a neural speaker verification model (ECAPA-TDNN via SpeechBrain) to match your vocal signature. Background voices, replays, and other people get rejected silently. Only you command Jarvis.

## Pre-Flight Checks

Before enrolling, verify the services are running:

```bash
curl -sf http://localhost:8767/health && echo "Speaker verify: running"
```

If the service isn't running:

```bash
# Linux
systemctl --user start jarvis-speaker-verify
systemctl --user status jarvis-speaker-verify

# Manual
source venv/bin/activate
python3 gpu-services/speaker_verify_service.py --device cpu &
sleep 5
curl -sf http://localhost:8767/health
```

Also check that the bot is configured:

```bash
grep SPEAKER_VERIFY_ENABLED .env
# Should not be false (true or unset = enabled when service is up)
```

## Enrollment

Ask the user to be in their normal speaking environment — same room, same mic position they'll use when talking to Jarvis.

```bash
cd /path/to/jarvis-voice
bash enroll-voice.sh
```

The script will prompt them to say 3 enrollment phrases. Guide the user:

> "When prompted, speak in your normal voice at normal volume — the same way 
> you'd actually give Jarvis a command. Don't whisper or shout. Just talk."

The 3 phrases (the script will show these):
1. "Jarvis, what's on my calendar today?"
2. "Run a security check on the network."
3. "Good morning, Jarvis. Brief me."

Each phrase is recorded twice for averaging. The model builds a voiceprint from the combined samples.

## Verification Test

After enrollment, test that it works:

```bash
# The enroll script runs this automatically, but you can re-test:
curl -sf http://localhost:8767/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Enrolled:', d.get('enrolled', False))"
```

Then ask the user to say one more phrase in Discord voice (after enabling SPEAKER_VERIFY_ENABLED). If Jarvis responds, enrollment succeeded.

## Enable Verification

After successful enrollment, enable in `.env`:

```
SPEAKER_VERIFY_ENABLED=true
```

Restart the voice bot:

```bash
systemctl --user restart jarvis-voice
# or kill and rerun node src/index.js
```

## Adjusting Sensitivity

If Jarvis is rejecting your voice too often (false negatives), lower the threshold:

```
SPEAKER_THRESHOLD=0.35   # More permissive (default: 0.45)
```

If Jarvis is accepting other voices (false positives), raise it:

```
SPEAKER_THRESHOLD=0.60   # More strict
```

Restart the speaker-verify service after changing the threshold.

## Re-enrollment

If you move to a new microphone, grow a beard, or voice recognition accuracy drops:

```bash
rm ~/.jarvis/owner_voiceprint.npy ~/.jarvis/owner_voiceprints.npy 2>/dev/null
bash enroll-voice.sh
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Enrolled: false" after running script | Script failed silently | Check `journalctl --user -u jarvis-speaker-verify -n 30` |
| Jarvis always rejects voice | Threshold too high | Lower SPEAKER_THRESHOLD to 0.30 |
| Jarvis accepts everyone | Threshold too low | Raise to 0.65, re-enroll with cleaner samples |
| Service won't start | CUDA error on CPU box | Add `--device cpu` flag to service ExecStart |
| Enrollment script not found | Wrong directory | Must run from the jarvis-voice repo root |
