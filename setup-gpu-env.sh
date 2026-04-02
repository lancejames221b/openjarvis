#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$REPO_DIR/venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

FORCE=false
PLATFORM=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true ;;
        --cpu)   PLATFORM=cpu ;;
        --cuda)  PLATFORM=cuda ;;
        --metal) PLATFORM=metal ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

echo "Setting up Jarvis Voice environment..."

# Detect platform if not specified
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ -z "$PLATFORM" ]]; then
    if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
        PLATFORM=metal
        echo "Detected: Apple Silicon -> using requirements-metal.txt"
    elif command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
        PLATFORM=cuda
        echo "Detected: NVIDIA GPU -> using requirements-cuda.txt"
    else
        PLATFORM=cpu
        echo "Detected: CPU only -> using requirements-cpu.txt"
    fi
fi

REQUIREMENTS="$REPO_DIR/requirements-${PLATFORM}.txt"
if [[ ! -f "$REQUIREMENTS" ]]; then
    echo "ERROR: requirements file not found: $REQUIREMENTS"
    exit 1
fi
echo "Using: $REQUIREMENTS"

# Python check
if ! command -v "$PYTHON_BIN" &>/dev/null; then
    echo "ERROR: Python not found ($PYTHON_BIN). Install Python 3.11+."
    exit 1
fi

# (Re)create venv
if $FORCE && [[ -d "$VENV_DIR" ]]; then
    echo "Force flag set: removing existing venv..."
    rm -rf "$VENV_DIR"
fi

if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating venv..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
else
    echo "Using existing venv (pass --force to rebuild)..."
fi

echo "Installing Python dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"

# Node deps
echo "Installing Node dependencies..."
cd "$REPO_DIR"
npm install

# Verify
echo "Verifying setup..."
"$VENV_DIR/bin/python3" -c "
import sys

try:
    import torch
    print(f'  torch: {torch.__version__}')
    if torch.cuda.is_available():
        print(f'  CUDA: {torch.cuda.get_device_name(0)}')
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        print('  MPS (Apple Silicon): available')
    else:
        print('  compute: CPU only')
except (ImportError, OSError) as e:
    print(f'  torch import failed: {e}')
    print('  STT/speaker-verify will fall back to CPU automatically.')

try:
    from faster_whisper import WhisperModel
    print('  faster-whisper: OK')
except ImportError as e:
    print(f'  faster-whisper: FAILED ({e})')
    sys.exit(1)
"

# Platform-specific post-install hints
if [[ "$PLATFORM" == "metal" ]]; then
    echo ""
    echo "Apple Silicon note:"
    echo "  For best STT performance, install mlx-whisper:"
    echo "    $VENV_DIR/bin/pip install mlx-whisper"
    echo "  Then set STT_PROVIDER=mlx-whisper in your .env"
fi

# Service checks (Linux systemd only)
if [[ "$OS" != "Darwin" ]] && command -v systemctl &>/dev/null; then
    echo "Checking systemd services..."
    systemctl --user daemon-reload 2>/dev/null || true
    for svc in jarvis-whisper-stt jarvis-piper-tts jarvis-speaker-verify; do
        if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
            echo "  $svc: running"
        fi
    done

    if systemctl --user is-active --quiet jarvis-voice 2>/dev/null; then
        echo "  jarvis-voice: running — restarting to pick up changes..."
        systemctl --user restart jarvis-voice
    else
        echo "  jarvis-voice: not running"
    fi
fi

echo ""
echo "Setup complete. Platform: $PLATFORM"
echo "Next: cp .env.example .env  and fill in your Discord token + OpenClaw URL."
