# pulse — Setup

## Required Configuration

Edit your OpenClaw config to set:

```bash
# In your skill or OpenClaw .env
YOUR_GOOGLE_EMAIL=you@yourdomain.com    # For Google Calendar + Gmail
YOUR_DISCORD_CHANNEL=general            # Where to post the full briefing
YOUR_TIMEZONE=America/New_York          # For weather and time formatting
YOUR_CITY=New_York                      # For weather
```

## Required MCP Services

| Source | MCP Server | Required? |
|--------|-----------|-----------|
| Calendar | google-workspace | Yes (if using Google Calendar) |
| Email | google-workspace | Yes (if using Gmail) |
| Slack | slack | Optional |
| GitHub PRs | github (via `gh` CLI) | Optional |
| Comms | comms-check skill | Optional |

## Google Workspace Setup

1. Configure google-workspace MCP in OpenClaw
2. Authenticate: `mcporter auth google-workspace`
3. Verify: `mcporter call google-workspace.list_events user_google_email='YOUR_EMAIL' max_results:3`

## Slack Setup (optional)

1. Configure slack MCP in OpenClaw
2. Authenticate: `mcporter auth slack`
3. Note your key channel IDs for the briefing

## Weather (no setup required)

Uses `wttr.in` — no API key needed. Just set `YOUR_CITY` in the skill config.

## Customize Sources

Edit the skill's implementation to add/remove sources. The briefing template is flexible — add anything your MCP stack can access.

## Schedule It

In OpenClaw, create a cron job:

```bash
openclaw cron add --schedule "0 8 * * 1-5" \
  --payload '{"kind":"systemEvent","text":"run morning briefing"}' \
  --timezone YOUR_TIMEZONE
```

Or trigger on demand: say **"brief me"** or **"morning briefing"**.
