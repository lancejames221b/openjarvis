---
name: jarvis-voice-briefing
description: Voice + text split output pattern for Jarvis. When in voice mode, deliver TL;DR summaries (2-4 sentences) over audio and post full detailed reports to a Discord channel. Never read long reports, tables, or detailed analysis over voice. Applies automatically whenever producing reports, analysis, summaries, or any detailed output during voice conversations.
tier: REACTOR
triggers:
  - automatic (applies to all voice-mode responses)
---

# jarvis-voice-briefing — Voice Output Pattern

This skill defines how Jarvis delivers information when you're in a voice session. It enforces the iron rule: **voice is for summaries, Discord is for details.**

## The Pattern

Every time Jarvis produces output that would be long, tabular, or detailed:

1. **Speak a 2-4 sentence TL;DR** — the actionable headline, nothing more
2. **Post the full report** to the configured Discord text channel
3. **Reference the channel** in the spoken output: *"Full report in #general, sir."*

## When This Applies

- Any report longer than 3-4 spoken sentences
- Tables, lists, code blocks, structured data
- Analysis with multiple sections
- Security intel, calendar summaries, search results
- Sub-agent outputs and tool results
- Anything you wouldn't naturally say out loud in conversation

## Voice Output Rules

**DO:**
- Speak the headline finding
- Give the number ("3 new threats", "2 meetings today", "5 unread messages")
- Name the action if one is needed ("Want me to block it?")
- End with where the detail lives ("Full breakdown in #jarvis-alerts")

**DON'T:**
- Read markdown aloud
- Say "asterisk asterisk" or "pound pound"
- Read URLs, hashes, IPs, or long identifiers verbatim
- Narrate tables row by row
- Give more than 4 sentences without user asking for more

## Example

**Bad (don't do this):**
> "Here are the results. Number one: CVE-2024-1234, severity critical, CVSS 9.8, affecting OpenSSH versions 8.0 through 9.3, patched in 9.4, affecting approximately 14 million servers, first reported by..."

**Good (do this):**
> "One critical CVE in OpenSSH — affects your version, patch is available. Details in #security-alerts."

## Implementation

When Jarvis has a long result to deliver during a voice session:

```
1. Generate the full report (normal quality, no shortcuts)
2. Synthesize a 2-4 sentence spoken version
3. Post full report to DISCORD_TEXT_CHANNEL_ID via message tool
4. Return the spoken TL;DR as the voice response
5. Append: "Full [report/breakdown/details] in #[channel-name], sir."
```

## Configuration

No configuration required. The pattern uses whatever text channel is set in the voice bot's `DISCORD_TEXT_CHANNEL_ID`.

To change the target channel per-skill, specify in the individual skill's SKILL.md.
