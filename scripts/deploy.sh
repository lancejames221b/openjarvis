#!/usr/bin/env bash
# Deploy OpenJarvis from dev (gamez) to live (generic).
# Usage: scripts/deploy.sh [generic|dev]
#   generic — full deploy + service restart (default)
#   dev     — dry-run only, no changes

set -euo pipefail

TARGET="${1:-generic}"
SRC="${JARVIS_DEV_PATH:-$HOME/Dev/openjarvis}"
LIVE="${JARVIS_LIVE_MOUNT:-$HOME/mnt/generic/dev/jarvis-voice}"
REMOTE="generic"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

if [[ "$TARGET" == "dev" ]]; then
  log "Dry run (no changes will be made)"
  rsync -avz --dry-run "$SRC/src/"         "$LIVE/src/"
  rsync -avz --dry-run "$SRC/scripts/"     "$LIVE/scripts/"
  rsync -avz --dry-run "$SRC/package.json" "$LIVE/package.json"
  exit 0
fi

[[ "$TARGET" == "generic" ]] || die "Unknown target '$TARGET' — use 'generic' or 'dev'"

# Require SSHFS mount
[[ -d "$LIVE/src" ]] || die "SSHFS not mounted at $LIVE — mount with: sshfs $REMOTE:/home/$REMOTE/dev/jarvis-voice $LIVE"

# Backup current live for rollback
BAK="${LIVE%/*}/jarvis-voice.bak"
log "Backing up current live → $BAK"
install -d "$BAK"
rsync -a --delete "$LIVE/src/"     "$BAK/src/"
rsync -a --delete "$LIVE/scripts/" "$BAK/scripts/"
cp "$LIVE/package.json" "$BAK/package.json" 2>/dev/null || true

# Sync source
log "Syncing src/ ..."
rsync -avz --delete "$SRC/src/"     "$LIVE/src/"
log "Syncing scripts/ ..."
rsync -avz --delete "$SRC/scripts/" "$LIVE/scripts/"
log "Syncing package.json ..."
rsync -avz "$SRC/package.json" "$LIVE/package.json"

# Restart services
log "Restarting jarvis-gateway and jarvis-voice on $REMOTE ..."
ssh "$REMOTE" "systemctl --user restart jarvis-gateway jarvis-voice"

# Brief pause for startup
sleep 3

# Verify
log "Checking service status ..."
ssh "$REMOTE" "systemctl --user is-active jarvis-voice jarvis-gateway"

# Tail logs
log "--- recent logs (Ctrl-C to exit) ---"
ssh "$REMOTE" "journalctl --user -u jarvis-voice -u jarvis-gateway --since '15 seconds ago' --no-pager -n 60"
