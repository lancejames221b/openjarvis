#!/usr/bin/env bash
#
# enroll-voice.sh -- Speaker Enrollment for Jarvis Voice
#
# Records voice samples and creates a voiceprint so Jarvis only responds
# to the enrolled owner. Uses the speaker verification GPU service.
#
# Requirements:
#   - arecord (alsa-utils) or sox (rec) for microphone recording
#   - Speaker verification service running on localhost:8767
#   - A working microphone
#
# Usage:
#   ./enroll-voice.sh                  # Interactive enrollment (10 clips)
#   ./enroll-voice.sh --clips 5        # Custom number of clips
#   ./enroll-voice.sh --from-dir /path # Enroll from existing WAV files
#   ./enroll-voice.sh --reset          # Reset enrollment and start over

set -euo pipefail

SPEAKER_SERVICE_URL="${SPEAKER_SERVICE_URL:-http://localhost:8767}"
NUM_CLIPS="${1:-10}"
CLIP_DURATION=5  # seconds per clip
ENROLLMENT_DIR="${ENROLLMENT_DIR:-/tmp/jarvis-enrollment}"
SAMPLE_RATE=16000

# Parse arguments
FROM_DIR=""
RESET_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clips)
            NUM_CLIPS="$2"
            shift 2
            ;;
        --from-dir)
            FROM_DIR="$2"
            shift 2
            ;;
        --reset)
            RESET_ONLY=true
            shift
            ;;
        --url)
            SPEAKER_SERVICE_URL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --clips N       Number of enrollment clips (default: 10)"
            echo "  --from-dir DIR  Enroll from existing WAV files in DIR"
            echo "  --reset         Reset enrollment accumulator"
            echo "  --url URL       Speaker service URL (default: http://localhost:8767)"
            echo ""
            echo "Environment:"
            echo "  SPEAKER_SERVICE_URL  Override service URL"
            echo "  ENROLLMENT_DIR       Override temp directory for recordings"
            exit 0
            ;;
        *)
            # Positional: treat as NUM_CLIPS for backward compat
            if [[ "$1" =~ ^[0-9]+$ ]]; then
                NUM_CLIPS="$1"
            fi
            shift
            ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Jarvis Voice Enrollment${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Check service health
echo -n "Checking speaker verification service... "
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${SPEAKER_SERVICE_URL}/health" 2>/dev/null || true)
if [ "$HEALTH" != "200" ]; then
    echo -e "${RED}FAILED${NC}"
    echo "Speaker verification service not reachable at ${SPEAKER_SERVICE_URL}"
    echo "Start it with: python3 gpu-services/speaker_verify_service.py"
    exit 1
fi
echo -e "${GREEN}OK${NC}"

# Reset if requested
if [ "$RESET_ONLY" = true ]; then
    echo -n "Resetting enrollment... "
    RESET_RESP=$(curl -s -X POST "${SPEAKER_SERVICE_URL}/enroll/reset")
    echo -e "${GREEN}Done${NC}"
    echo "$RESET_RESP" | python3 -m json.tool 2>/dev/null || echo "$RESET_RESP"
    exit 0
fi

# Reset any previous partial enrollment
curl -s -X POST "${SPEAKER_SERVICE_URL}/enroll/reset" > /dev/null

# Find recording tool
RECORDER=""
if command -v arecord &>/dev/null; then
    RECORDER="arecord"
elif command -v rec &>/dev/null; then
    RECORDER="rec"
elif command -v ffmpeg &>/dev/null; then
    RECORDER="ffmpeg"
else
    echo -e "${RED}No recording tool found.${NC}"
    echo "Install one of: alsa-utils (arecord), sox (rec), or ffmpeg"
    echo ""
    echo "Alternatively, provide pre-recorded WAV files:"
    echo "  $0 --from-dir /path/to/wav/files"
    exit 1
fi

# Enroll from existing directory
if [ -n "$FROM_DIR" ]; then
    echo -e "${CYAN}Enrolling from WAV files in: ${FROM_DIR}${NC}"
    CLIP_NUM=0
    for wav_file in "${FROM_DIR}"/*.wav; do
        [ -f "$wav_file" ] || continue
        CLIP_NUM=$((CLIP_NUM + 1))
        echo -n "  Clip #${CLIP_NUM}: $(basename "$wav_file")... "
        RESP=$(curl -s -X POST -F "audio=@${wav_file}" "${SPEAKER_SERVICE_URL}/enroll")
        ACCEPTED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted', False))" 2>/dev/null || echo "False")
        if [ "$ACCEPTED" = "True" ]; then
            echo -e "${GREEN}accepted${NC}"
        else
            REASON=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason', 'unknown'))" 2>/dev/null || echo "unknown")
            echo -e "${YELLOW}rejected (${REASON})${NC}"
        fi
    done

    if [ "$CLIP_NUM" -lt 3 ]; then
        echo -e "${RED}Need at least 3 clips. Found ${CLIP_NUM}.${NC}"
        exit 1
    fi

    echo ""
    echo -n "Finalizing voiceprint... "
    FINAL=$(curl -s -X POST "${SPEAKER_SERVICE_URL}/enroll/finalize")
    SAVED=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('saved', False))" 2>/dev/null || echo "False")
    if [ "$SAVED" = "True" ]; then
        echo -e "${GREEN}Done!${NC}"
        echo "$FINAL" | python3 -m json.tool 2>/dev/null || echo "$FINAL"
    else
        echo -e "${RED}Failed${NC}"
        echo "$FINAL"
        exit 1
    fi
    exit 0
fi

# Interactive enrollment
mkdir -p "$ENROLLMENT_DIR"

PROMPTS=(
    "Please say: 'Jarvis, what time is it?'"
    "Please say: 'Hey Jarvis, check the weather for today.'"
    "Please say: 'Jarvis, read me the latest alerts.'"
    "Please say: 'Can you search for recent news about cybersecurity?'"
    "Please say any sentence naturally for 3-5 seconds."
    "Please say: 'Jarvis, what's on my calendar today?'"
    "Please say: 'Run a status check on all systems.'"
    "Please say any natural sentence -- speak as you normally would."
    "Please say: 'Jarvis, summarize the last conversation.'"
    "Please count from one to ten at your normal speaking pace."
    "Please say: 'Deploy the latest build to staging.'"
    "Please say anything you like -- just keep talking for a few seconds."
)

echo ""
echo -e "${CYAN}Recording ${NUM_CLIPS} voice samples (${CLIP_DURATION}s each).${NC}"
echo -e "Speak clearly into your microphone. Background noise is OK."
echo ""

ACCEPTED=0
for i in $(seq 1 "$NUM_CLIPS"); do
    PROMPT_IDX=$(( (i - 1) % ${#PROMPTS[@]} ))
    echo -e "${YELLOW}[${i}/${NUM_CLIPS}]${NC} ${PROMPTS[$PROMPT_IDX]}"
    echo -n "  Press ENTER to start recording..."
    read -r

    WAV_FILE="${ENROLLMENT_DIR}/enroll_${i}.wav"

    echo -ne "  ${RED}Recording (${CLIP_DURATION}s)...${NC} "

    case "$RECORDER" in
        arecord)
            arecord -f S16_LE -r "$SAMPLE_RATE" -c 1 -d "$CLIP_DURATION" "$WAV_FILE" 2>/dev/null
            ;;
        rec)
            rec -r "$SAMPLE_RATE" -c 1 -b 16 "$WAV_FILE" trim 0 "$CLIP_DURATION" 2>/dev/null
            ;;
        ffmpeg)
            ffmpeg -y -f alsa -i default -ar "$SAMPLE_RATE" -ac 1 -t "$CLIP_DURATION" "$WAV_FILE" 2>/dev/null
            ;;
    esac

    echo -ne "${GREEN}Done.${NC} Uploading... "

    # POST to enrollment endpoint
    RESP=$(curl -s -X POST -F "audio=@${WAV_FILE}" "${SPEAKER_SERVICE_URL}/enroll")
    WAS_ACCEPTED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted', False))" 2>/dev/null || echo "False")

    if [ "$WAS_ACCEPTED" = "True" ]; then
        ACCEPTED=$((ACCEPTED + 1))
        TOTAL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('clips_collected', 0))" 2>/dev/null || echo "?")
        echo -e "${GREEN}Accepted (${TOTAL} total)${NC}"
    else
        REASON=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason', 'unknown'))" 2>/dev/null || echo "unknown")
        echo -e "${YELLOW}Rejected: ${REASON} -- try again with more speech${NC}"
    fi
    echo ""
done

# Finalize
echo -e "${CYAN}========================================${NC}"
echo -e "Accepted ${ACCEPTED} of ${NUM_CLIPS} clips."
echo ""

if [ "$ACCEPTED" -lt 3 ]; then
    echo -e "${RED}Need at least 3 accepted clips to create a voiceprint.${NC}"
    echo "Run enrollment again with clearer speech samples."
    exit 1
fi

echo -n "Finalizing voiceprint... "
FINAL=$(curl -s -X POST "${SPEAKER_SERVICE_URL}/enroll/finalize")
SAVED=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('saved', False))" 2>/dev/null || echo "False")

if [ "$SAVED" = "True" ]; then
    CLIPS_AVG=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('clips_averaged', 0))" 2>/dev/null || echo "?")
    VP_PATH=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('path', 'unknown'))" 2>/dev/null || echo "unknown")
    echo -e "${GREEN}Success!${NC}"
    echo ""
    echo -e "  Voiceprint: ${VP_PATH}"
    echo -e "  Clips averaged: ${CLIPS_AVG}"
    echo -e "  Similarity threshold: ${SPEAKER_THRESHOLD:-0.65}"
    echo ""
    echo -e "${GREEN}Speaker verification is now active.${NC}"
    echo "Jarvis will only respond to your voice."
else
    echo -e "${RED}Failed to finalize voiceprint.${NC}"
    echo "$FINAL"
    exit 1
fi

# Cleanup
rm -rf "$ENROLLMENT_DIR"
echo ""
echo "Enrollment complete."
