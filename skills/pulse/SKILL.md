---
name: pulse
description: Daily morning briefing — spoken earpiece summary covering calendar, weather, email highlights, Slack, GitHub PRs, and communications. Triggered at a scheduled time or on demand. Delivers spoken TL;DR via Jarvis voice and full details to your Discord text channel.
tier: FRIDAY
triggers:
  - "morning briefing"
  - "brief me"
  - "what's my day look like"
  - "daily briefing"
  - "pulse"
  - "good morning Jarvis"
  - "what do I have today"
  - "run the morning brief"
---

# pulse — Morning Briefing

Your day, in 60 seconds, before you get out of bed.

Jarvis pulls everything that matters — calendar, weather, urgent email, Slack highlights, open PRs — synthesizes it into a 4-6 sentence spoken briefing, and posts the full breakdown to Discord.

## What It Covers

| Source | What Jarvis checks |
|--------|-------------------|
| Calendar | Events in the next 24h, anything starting soon |
| Weather | Today's forecast for your city |
| Email | Unread from important senders, flagged/starred |
| Slack | Unread DMs, mentions in key channels |
| GitHub | Open PRs needing review, CI failures |
| Comms | New texts/Signal if comms-check skill installed |

Configure which sources to include in `SETUP.md`.

## Voice Output

**Spoken (2-4 sentences, Jarvis voice):**
> "Good morning. You have a standup at 9 and a client call at 2 — both on calendar. 
> Three unread emails, one from your CEO flagged urgent. Rain this afternoon. 
> Full briefing in #general."

**Full report (Discord text channel):**
- Calendar: all events with times, links, attendees
- Weather: hourly breakdown
- Email: subject lines + senders for top 5
- Slack: channel highlights, DM count
- PRs: open reviews with staleness
- Comms: message count by sender

## Scheduling

To run automatically at 8am weekdays, add a cron job in OpenClaw:

```
schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "YOUR_TIMEZONE" }
payload: { kind: "systemEvent", text: "run morning briefing" }
```

Or just say **"brief me"** any time on demand.

## Configuration

See `SETUP.md` for required MCP services and env variables.

## Customize the Brief

Add or remove sources by editing which MCP calls are made in the skill. Common customizations:
- Skip Slack if you don't use it
- Add Linear/Jira ticket counts
- Add stock prices or crypto
- Add a custom RSS feed for industry news
- Read a specific Slack channel's highlights

The brief is yours. Make it relevant.
