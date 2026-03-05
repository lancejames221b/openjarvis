# comms-check — Setup

## Requirements

### 1. Mac Node (for iMessage + call history)

Your Mac must be paired as an OpenClaw node. This is what allows Jarvis to read your iMessage and call history.

**Pair your Mac:**
1. Install OpenClaw node on Mac: follow [OpenClaw node setup docs](https://docs.openclaw.ai/nodes)
2. Verify: In OpenClaw, run `nodes action=status` — your Mac should appear
3. Set `YOUR_MAC_NODE_NAME` in the skill config (e.g. "MacBook Pro")

**Install imsg on Mac:**
```bash
# On your Mac
brew install imsg  # or install from https://github.com/nicholasgasior/imsg
```

**Verify:**
```bash
# From OpenClaw (Linux host)
nodes action=run node="YOUR_MAC_NODE_NAME" command=["imsg", "--version"]
```

### 2. Signal Daemon (for Signal messages)

Requires `signal-cli` running as a daemon on your Linux host.

```bash
# Install signal-cli
# See https://github.com/AsamK/signal-cli for platform-specific install

# Register your number (one-time)
signal-cli -u YOUR_PHONE_NUMBER register
signal-cli -u YOUR_PHONE_NUMBER verify YOUR_CODE

# Run as daemon
signal-cli -u YOUR_PHONE_NUMBER daemon --tcp localhost:8085
```

**Configuration:**
```bash
SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX
SIGNAL_DAEMON_HOST=localhost
SIGNAL_DAEMON_PORT=8085
```

### 3. Voicemail (optional)

**AT&T:**
```bash
VOICEMAIL_CARRIER=att
VOICEMAIL_PIN=XXXX
```

**T-Mobile:**
T-Mobile VVM uses dynamically-provisioned IMAP credentials. Send `Activate:dt=6` to 122 from your phone to provision, then configure:
```bash
VOICEMAIL_CARRIER=tmobile
VOICEMAIL_PIN=XXXX
```

**Verizon:**
```bash
VOICEMAIL_CARRIER=verizon
VOICEMAIL_PIN=XXXX
```

### 4. State File

comms-check stores its watermark here:
```
~/dev/memory/comms-check-state.json
```

Create the directory if it doesn't exist:
```bash
mkdir -p ~/dev/memory
```

## Skill Configuration

Set these in your skill or OpenClaw environment:

```bash
YOUR_MAC_NODE_NAME="MacBook Pro"       # Name of your paired Mac node
YOUR_PHONE_NUMBER="+1XXXXXXXXXX"       # Your phone number for Signal
YOUR_DISCORD_CHANNEL=general           # Where to post full reports
COMMS_STATE_FILE=~/dev/memory/comms-check-state.json
```

## Verify Setup

```bash
# Test iMessage access
# (In OpenClaw) Say: "check my texts"

# Test Signal
curl -X POST http://localhost:8085/api/v1/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"receive","id":1}'

# Test call history
# (In OpenClaw) Say: "any missed calls"
```
