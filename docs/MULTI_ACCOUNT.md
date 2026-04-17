# Multi-Account Channel Routing

Jarvis Gateway can route different Discord channels to different Claude accounts. This lets you:

- Dedicate a channel to a guest who has their own Claude Teams seat
- Use your Max subscription in some channels and a separate account in others
- Keep session histories (and rate limits) cleanly separated per channel

---

## Policy — what's allowed

Each channel profile **must use credentials legitimately held by the humans using that channel**:

| Source | Allowed? |
|---|---|
| Your own Claude Max subscription | ✅ |
| Your own Claude Teams seat | ✅ |
| A Claude Teams seat legitimately held by the guest | ✅ (guest authenticates themselves) |
| The guest's own Anthropic API key | ✅ |
| Sharing your single Max subscription with another human | ❌ — violates [Anthropic ToS](https://support.claude.com/en/articles/11049762-choosing-a-claude-plan) |

**Key rule**: One Max or Teams seat = one human. The bot is a routing layer, not a way to share a single subscription across multiple people.

---

## How it works

Each profile points to a separate config directory (like `~/.claude-alex`) containing that person's own OAuth credentials. When a request arrives from a channel, the gateway injects `CLAUDE_CONFIG_DIR=<path>` before spawning `claude -p`, so that session uses entirely that person's account — rate limits, model access, and session history are all separate.

---

## Setup walkthrough

### 1. Guest authenticates their own profile directory

The guest (or you, for a second account) must run `claude login` with a custom `CLAUDE_CONFIG_DIR`:

```bash
# Replace "alex" with the guest's name
CLAUDE_CONFIG_DIR=~/.claude-alex claude login
```

This opens a browser OAuth flow using the guest's Claude account. They can do this on your machine over SSH, or you can walk through it together. The credentials are stored in `~/.claude-alex/` (not shared with your `~/.claude/`).

Verify it worked:
```bash
CLAUDE_CONFIG_DIR=~/.claude-alex claude --version
# Should show their account details, not yours
```

### 2. Add the profile to Jarvis

```bash
node scripts/jarvis-admin.js add-profile alex \
  --config-dir ~/.claude-alex \
  --label "Alex's Teams seat" \
  --i-understand
```

The `--i-understand` flag acknowledges the policy above. You'll see it printed first time without the flag.

### 3. Map a Discord channel to the profile

Find the channel ID (right-click channel in Discord → Copy ID):

```bash
node scripts/jarvis-admin.js map-channel channel:1234567890 alex
```

### 4. Reload the running gateway

```bash
node scripts/jarvis-admin.js reload
# Or: systemctl --user restart jarvis-gateway
```

### 5. Verify

```bash
node scripts/jarvis-admin.js list
```

Expected output:
```
=== Profiles ===
  default: primary (process owner) | configDir: (default) | creds: ✓
  alex: Alex's Teams seat | configDir: /home/you/.claude-alex | creds: ✓

=== Channel Mappings ===
  channel:1234567890 → alex
```

---

## Optional: Pin a channel to specific Discord users

Prevent someone accidentally joining a mapped channel and consuming the guest's tokens:

```bash
# In .env:
CHANNEL_USER_PINS={"channel:1234567890":["alex_discord_id","your_discord_id"]}
```

Only the listed users can trigger responses in that channel. Others are silently ignored.

---

## Removing a profile

```bash
node scripts/jarvis-admin.js unmap-channel channel:1234567890
node scripts/jarvis-admin.js remove-profile alex
node scripts/jarvis-admin.js reload
```

---

## Troubleshooting

**"credentials not found" warning in logs**: The profile's `CLAUDE_CONFIG_DIR` doesn't have a `.credentials.json`. The guest needs to run `CLAUDE_CONFIG_DIR=<path> claude login` again (tokens may have expired).

**Channel still using default account**: Check `node scripts/jarvis-admin.js list` and verify the channel key format. Channel IDs in the gateway are prefixed with `channel:` (e.g. `channel:1234567890`).

**"CLAUDE_CONFIG_DIR" ignored**: If the claude CLI version you're running doesn't respect this variable, check `journalctl --user -u jarvis-gateway | grep profile_warn`. You can fall back to Anthropic API keys instead — set `ANTHROPIC_API_KEY` in a per-profile env block (not currently wired in; open a PR or issue if needed).
