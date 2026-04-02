---
name: jarvis-evolve
description: Jarvis self-evolution — recommends, generalizes, and shares skills with the community. Triggers when Jarvis notices a repeated pattern, a useful workflow, or when the user asks to generalize or share something. Also handles explicit upgrade requests.
tier: FRIDAY
triggers:
  - "generalize this skill"
  - "share this with the community"
  - "submit this to Jarvis Voice"
  - "make this a skill"
  - "turn this into a skill"
  - "could this be a skill"
  - "should we share this"
  - automatic (Jarvis recommends proactively after 3+ similar requests)
---

# jarvis-evolve — Self-Evolution Engine

This is what makes Jarvis yours — and makes the community better.

Jarvis learns your patterns. When it notices something you do repeatedly — a workflow, a data source you always check, a command pattern that isn't a skill yet — it offers to package it. If you say yes, it generalizes it (removes your personal data), creates a proper SKILL.md, and opens a PR against `lancejames221b/jarvis-voice` for the community.

Your Jarvis doesn't just run your life. It helps build Jarvis for everyone.

---

## How It Works

### Proactive Recommendation (automatic)

After 3+ similar requests that aren't covered by an existing skill, Jarvis says:

> "I've noticed you ask me to check [thing] fairly often. Want me to turn that into a proper skill? I can generalize it and submit it to the Jarvis Voice repo for others to use — or just keep it local."

Options:
- **"Yes, share it"** → generalize + open GitHub PR
- **"Yes, keep it local"** → create SKILL.md in local skills dir only
- **"Not yet"** → dismiss, check again after 5 more similar requests
- **"No"** → suppress recommendation for this pattern permanently

### On-Demand ("make this a skill")

When you describe a workflow or ask Jarvis to package something:

1. Jarvis asks: *"What should this skill do? Give me the core behavior."*
2. Asks: *"What triggers it? What would you say to invoke it?"*
3. Asks: *"Any dependencies? What does it need to work?"*
4. Generates the SKILL.md (with all personal data replaced by placeholders)
5. Asks: *"Share with the community, keep it local, or both?"*

### Community Submission

If sharing:

```bash
# Clone the repo to a temp dir
git clone https://github.com/lancejames221b/jarvis-voice.git /tmp/jarvis-pr
cd /tmp/jarvis-pr

# Create a branch
git checkout -b skill/[skill-name]

# Write the generalized skill
mkdir -p skills/[skill-name]
# ... write SKILL.md and SETUP.md ...

# Commit and push
git add skills/[skill-name]/
git commit -m "feat: add [skill-name] skill"
git push origin skill/[skill-name]

# Open PR via gh CLI
gh pr create \
  --title "skill: [skill-name] — [one line description]" \
  --body "[what it does, what it needs, how to use it]"
```

Jarvis handles all of this. You just say yes.

---

## Personalization Engine

Beyond skills, Jarvis tracks what's working for you and what isn't:

**What Jarvis learns:**
- Which STT provider gives you the fewest mis-transcriptions
- What time of day you use voice vs text
- Which response length you prefer (you frequently say "shorter" or "more detail")
- Which skills you use daily vs never
- Your vocabulary — project names, people, places that Whisper keeps getting wrong

**Jarvis tunes itself:**
- Adds your frequently-used terms to the Whisper vocabulary prompt
- Adjusts `MAX_SPOKEN_SECONDS` based on your feedback
- Suggests disabling skills you haven't used in 30+ days
- Recommends new skills from the community that match your usage patterns

**You stay in control.** Every change is proposed, not automatic. Jarvis asks first.

---

## Upgrade Recommendation

When a new skill lands in the community repo that matches your patterns:

> "A new skill was submitted to Jarvis Voice — [name]. It does [thing you do manually]. 
> Want me to install it?"

Say yes → Jarvis installs it, configures it, and it's live.

---

## Privacy

When generalizing a skill for sharing:
- All personal data is stripped (phone numbers, IPs, names, account IDs, internal URLs)
- Replaced with documented placeholders (`YOUR_PHONE_NUMBER`, `YOUR_SERVER_IP`, etc.)
- You review the generalized version before it's submitted
- Nothing is submitted without explicit approval

Your personal config, voiceprint, and local-only skills never leave your machine.

---

## The Vision

Every time someone builds something cool with Jarvis and shares it, every Jarvis gets a little more capable. The system compounds. The community grows. Your Jarvis today is better than it was last week because someone else figured something out and shared it.

That's how you build a living AI system, not a static tool.
