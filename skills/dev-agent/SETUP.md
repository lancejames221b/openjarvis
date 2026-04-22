# dev-agent Setup

## Requirements

- `dev-session` script at `~/.local/bin/dev-session` (see below)
- `qterminal` installed
- Claude Code CLI at `~/.local/bin/claude`
- Git repos under `~/Dev/` (or configure `DEV_ROOT` below)

## Install dev-session script

Save to `~/.local/bin/dev-session` and `chmod +x`:

```bash
chmod +x ~/.local/bin/dev-session
```

The script is installed automatically if you run the openjarvis installer.

## Configuration

No `.env` required. The script uses these defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEV_ROOT` | `~/Dev` | Root directory containing your repos |
| `CLAUDE_BIN` | `~/.local/bin/claude` | Path to Claude Code CLI |

Override by exporting in your shell profile:

```bash
export DEV_ROOT=/path/to/your/repos
```

## Testing

```bash
dev-session openjarvis "test session"
# Should open a qterminal with Claude Code in ~/Dev/openjarvis
# on branch dev/test-session
```

## Finding your repos

```bash
ls ~/Dev/
# openjarvis  haivemind  claudeflare  ...
```

## How safety constraints work

`dev-session` writes a `CLAUDE.md` fragment to `.claude/CLAUDE.md` in the target repo. Claude Code reads this file on startup and enforces the rules for the session:

- No `git push`
- No `gh pr create`
- No merge to main/master
- Commits to feature branch are fine

The `.claude/` directory is gitignored by default in most repos, so these session rules don't get committed.
