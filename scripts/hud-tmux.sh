#!/usr/bin/env bash
# hud-tmux.sh — Launch or attach to the Jarvis tmux HUD session
#
# Creates a 3-pane tmux layout:
#   ┌─────────────────────────────────────┐
#   │  pane 0: live HUD dashboard (top)   │
#   ├─────────────────────────────────────┤
#   │  pane 1: bot logs (bottom)          │
#   └─────────────────────────────────────┘
#
# Usage:
#   ~/jarvis-voice/scripts/hud-tmux.sh          # attach/create
#   ~/jarvis-voice/scripts/hud-tmux.sh kill     # kill session

SESSION="jarvis-hud"
BOT_DIR="${JARVIS_DIR:-$HOME/jarvis-voice}"
SCRIPT="$BOT_DIR/scripts/hud-render.js"

if [[ "$1" == "kill" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "Killed $SESSION" || echo "No session to kill"
  exit 0
fi

# If session exists, just attach
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION"
fi

# Create detached session (wide enough for the dashboard)
tmux new-session -d -s "$SESSION" -x "${COLUMNS:-200}" -y "${LINES:-50}"

# Pane 0 (top, ~65%): live HUD — refresh every 2s
tmux send-keys -t "${SESSION}:0.0" \
  "watch -n 2 -t 'node $SCRIPT 2>&1 || echo \"[renderer error — check node/path]\"'" \
  Enter

# Split bottom 35% for logs
tmux split-window -v -p 35 -t "${SESSION}:0"

# Pane 1 (bottom): bot journal — filter noisy TTS lines
tmux send-keys -t "${SESSION}:0.1" \
  "journalctl --user -u jarvis-voice -f --no-pager -o cat 2>/dev/null \
   | grep --line-buffered -Ev 'Kokoro TTS|bm_lewis|TTS provider'" \
  Enter

# Focus back to HUD pane
tmux select-pane -t "${SESSION}:0.0"

# Attach
exec tmux attach-session -t "$SESSION"
