---
name: comms-check
description: Unified communications check — iMessage texts, Signal messages, recent phone calls, and optional voicemail. Invocable on-demand or from voice. Produces TL;DR for voice and full report for Discord.
tier: FRIDAY
triggers:
  - "comms check"
  - "check my texts"
  - "check my messages"
  - "check Signal"
  - "any calls"
  - "any missed calls"
  - "what did I miss"
  - "check my calls"
  - "communications check"
  - "what messages do I have"
---

# comms-check — Unified Communications Briefing

One command. Every message across every channel, since you last checked.

Checks iMessage, Signal, and call history in one pass. Only shows what's new since the last check — no noise, no reruns. Watermark-based so you never see the same message twice.

## What It Checks

| Source | What's retrieved |
|--------|-----------------|
| iMessage | New messages across all conversations since last check |
| Signal | Pending/undelivered messages |
| Phone calls | Recent missed and received calls |
| Voicemail | (Optional — requires carrier config) |

## Voice Output

**Spoken:**
> "You have 3 new iMessages — 2 from your wife, 1 from a number you don't have saved. 
> One Signal message from a contact. One missed call this morning. Full report in #general."

**Discord (full report):**
```
📱 COMMS CHECK — [timestamp]

📩 iMessage (new since last check)
  • [Contact name]: "[message preview]" ([time])
  • [Contact name]: "[message preview]" ([time])

🔒 Signal
  • [Contact]: "[preview]" ([time])

📞 Calls
  📵 MISSED — [Contact name] ([time], [duration])

📬 Voicemail
  ⚠️ Not configured
```

## Watermark System

comms-check tracks when it last ran and only shows messages since then. First run ever shows the last 24 hours. Subsequent runs show only what's new.

State stored at `~/dev/memory/comms-check-state.json` (or your configured path).

Override: add `--hours 48` to see the last 48 hours regardless of watermark.

## Data Sources

### iMessage
- Requires: Mac node paired with OpenClaw (see SETUP.md)
- Uses `imsg` CLI on Mac to query the Messages database directly
- Read-only — does not send or mark messages as read

### Signal
- Requires: Signal daemon running on the Linux host (signal-cli)
- Calls `receive` via JSON-RPC to get pending messages
- Non-destructive — messages remain on Signal servers for 30 days

### Call History
- Requires: Mac node paired with OpenClaw
- Reads CallHistoryDB from Mac (synced from iPhone via Continuity)
- Resolves contact names from Mac Contacts

### Voicemail (optional)
- Carrier-dependent — see SETUP.md for configuration

## Setup

See `SETUP.md` for Mac node pairing, Signal daemon, and carrier voicemail config.
