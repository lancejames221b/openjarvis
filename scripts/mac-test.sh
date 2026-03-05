#!/bin/bash
# mac-test.sh — isolated test environment for Jarvis Voice on Apple Silicon
#
# Starts mlx-whisper (STT), piper-tts (TTS), and the voice bot pointed at a
# test Discord bot. Nothing touches the production .env.
#
# Prerequisites:
#   - macOS 13+ with Apple Silicon (M1/M2/M3/M4)
#   - Python 3.11+ (brew install python@3.11)
#   - Node.js 22+ (brew install node)
#   - ffmpeg (brew install ffmpeg)
#   - A test Discord bot token (separate from production)
#   - .env.mac-test filled in (cp .env.mac-test.example .env.mac-test)
#
# Usage:
#   ./scripts/mac-test.sh           # start all services
#   ./scripts/mac-test.sh --stop    # stop all background services
#   ./scripts/mac-test.sh --logs    # tail logs

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.mac-test"
VENV_DIR="$REPO_DIR/venv-mac-test"
LOG_DIR="$REPO_DIR/tmp/mac-test-logs"
PIDS_FILE="$REPO_DIR/tmp/mac-test.pids"

# ── Flags ────────────────────────────────────────────────────────────────────

ACTION="start"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --stop)  ACTION=stop ;;
        --logs)  ACTION=logs ;;
        --clean) ACTION=clean ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

# ── Stop ─────────────────────────────────────────────────────────────────────

if [[ "$ACTION" == "stop" ]]; then
    if [[ -f "$PIDS_FILE" ]]; then
        while IFS= read -r pid; do
            kill "$pid" 2>/dev/null && echo "Stopped PID $pid" || true
        done < "$PIDS_FILE"
        rm -f "$PIDS_FILE"
        echo "All mac-test services stopped."
    else
        echo "No PID file found — services may not be running."
    fi
    exit 0
fi

if [[ "$ACTION" == "logs" ]]; then
    tail -f "$LOG_DIR"/*.log 2>/dev/null || echo "No logs found at $LOG_DIR"
    exit 0
fi

if [[ "$ACTION" == "clean" ]]; then
    bash "$0" --stop 2>/dev/null || true
    rm -rf "$VENV_DIR" "$LOG_DIR"
    echo "Cleaned mac-test venv and logs."
    exit 0
fi

# ── Start ─────────────────────────────────────────────────────────────────────

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "ERROR: mac-test.sh is for macOS only."
    echo "On Linux, use docker compose or setup-gpu-env.sh."
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found."
    echo "Copy and fill in: cp .env.mac-test.example .env.mac-test"
    exit 1
fi

mkdir -p "$LOG_DIR"
rm -f "$PIDS_FILE"

# ── Python venv ───────────────────────────────────────────────────────────────

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
if ! command -v "$PYTHON_BIN" &>/dev/null; then
    PYTHON_BIN="python3"
fi

if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating mac-test venv ($PYTHON_BIN)..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
    "$VENV_DIR/bin/pip" install -r "$REPO_DIR/requirements-metal.txt" --quiet
    echo "Installing mlx-whisper for Apple Silicon STT..."
    "$VENV_DIR/bin/pip" install mlx-whisper --quiet
fi

PYTHON="$VENV_DIR/bin/python3"

# ── mlx-whisper STT server ────────────────────────────────────────────────────

echo "Starting mlx-whisper STT server on port 8765..."
"$PYTHON" -m mlx_whisper.server \
    --model distil-large-v3 \
    --port 8765 \
    > "$LOG_DIR/mlx-whisper.log" 2>&1 &
MLX_PID=$!
echo "$MLX_PID" >> "$PIDS_FILE"
echo "  PID $MLX_PID"

# ── Piper TTS service ─────────────────────────────────────────────────────────

echo "Starting Piper TTS service on port 3336..."
PIPER_MODELS_DIR="$REPO_DIR/models/jarvis" \
PIPER_BIN="$VENV_DIR/bin/piper" \
"$PYTHON" "$REPO_DIR/gpu-services/piper_tts_service.py" \
    > "$LOG_DIR/piper-tts.log" 2>&1 &
PIPER_PID=$!
echo "$PIPER_PID" >> "$PIDS_FILE"
echo "  PID $PIPER_PID"

# ── Speaker verify (optional, CPU/MPS) ───────────────────────────────────────

# Check if speaker verify is enabled in the test env
SPEAKER_ENABLED=$(grep -E '^SPEAKER_VERIFY_ENABLED=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')
if [[ "$SPEAKER_ENABLED" == "true" ]]; then
    echo "Starting speaker-verify service on port 8767 (CPU/MPS)..."
    "$PYTHON" "$REPO_DIR/gpu-services/speaker_verify_service.py" \
        --device cpu \
        > "$LOG_DIR/speaker-verify.log" 2>&1 &
    SV_PID=$!
    echo "$SV_PID" >> "$PIDS_FILE"
    echo "  PID $SV_PID"
fi

# ── Wait for services ─────────────────────────────────────────────────────────

echo ""
echo "Waiting for services to come up..."
sleep 5

for url in "http://localhost:8765/health" "http://localhost:3336/health"; do
    for i in {1..12}; do
        if curl -sf "$url" &>/dev/null; then
            echo "  $url: ready"
            break
        fi
        sleep 2
        if [[ $i -eq 12 ]]; then
            echo "  WARNING: $url did not respond — check $LOG_DIR/"
        fi
    done
done

# ── Node voice bot ────────────────────────────────────────────────────────────

echo ""
echo "Starting Jarvis voice bot (test mode)..."
cd "$REPO_DIR"

# Load test env and start bot
set -a
# shellcheck source=../.env.mac-test
source "$ENV_FILE"
set +a

node --max-old-space-size=2048 src/index.js \
    > "$LOG_DIR/voice-bot.log" 2>&1 &
BOT_PID=$!
echo "$BOT_PID" >> "$PIDS_FILE"

echo ""
echo "Mac test environment running."
echo ""
echo "  STT:          mlx-whisper  -> http://localhost:8765"
echo "  TTS:          piper-tts    -> http://localhost:3336"
if [[ "$SPEAKER_ENABLED" == "true" ]]; then
echo "  Speaker:      speaker-verify -> http://localhost:8767"
fi
echo "  Voice bot:    PID $BOT_PID"
echo ""
echo "  Logs:         $LOG_DIR/"
echo "  Stop:         ./scripts/mac-test.sh --stop"
echo "  Tail logs:    ./scripts/mac-test.sh --logs"
