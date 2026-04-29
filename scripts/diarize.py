#!/usr/bin/env python3
"""
diarize.py — Transcript-based speaker diarization

Pipeline:
  1. Download audio (yt-dlp if URL, else use file directly)
  2. Transcribe with Whisper → SRT (timestamps)
  3. Send transcript + context to Claude → speaker labels deduced from content
  4. Output labeled transcript

Usage:
  python3 diarize.py <url_or_file> [--speakers N] [--context "hint about speakers"]
  python3 diarize.py https://youtube.com/shorts/xxx
  python3 diarize.py audio.mp3 --speakers 2 --context "BBC interview, host and guest"
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import json
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────
WHISPER_BIN = os.environ.get("WHISPER_PATH", f"{Path.home()}/.local/bin/whisper")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "turbo")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")

def download_audio(url: str, out_dir: str) -> str:
    """Download audio from URL using yt-dlp, return path to mp3."""
    print(f"⬇️  Downloading: {url}", file=sys.stderr)
    out_path = os.path.join(out_dir, "audio.%(ext)s")
    subprocess.run(
        ["yt-dlp", "-x", "--audio-format", "mp3", "-o", out_path, url],
        check=True, capture_output=True
    )
    mp3 = os.path.join(out_dir, "audio.mp3")
    if not os.path.exists(mp3):
        raise FileNotFoundError(f"Expected {mp3} after download")
    return mp3

def transcribe(audio_path: str, out_dir: str) -> str:
    """Run Whisper, return SRT content."""
    print(f"🎙️  Transcribing: {audio_path}", file=sys.stderr)
    subprocess.run(
        [WHISPER_BIN, audio_path,
         "--model", WHISPER_MODEL,
         "--output_format", "srt",
         "--output_dir", out_dir],
        check=True, capture_output=True
    )
    stem = Path(audio_path).stem
    srt_path = os.path.join(out_dir, f"{stem}.srt")
    return Path(srt_path).read_text()

def parse_srt(srt: str) -> list[dict]:
    """Parse SRT into list of {index, start, end, text}."""
    blocks = re.split(r'\n\n+', srt.strip())
    segments = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        idx = lines[0].strip()
        timing = lines[1].strip()
        text = " ".join(lines[2:]).strip()
        m = re.match(r'(\S+)\s+-->\s+(\S+)', timing)
        if m:
            segments.append({
                "index": idx,
                "start": m.group(1),
                "end": m.group(2),
                "text": text
            })
    return segments

def diarize_with_claude(segments: list[dict], num_speakers: int, context_hint: str) -> list[dict]:
    """Send transcript to Claude via Jarvis gateway, get back speaker labels."""
    import urllib.request

    GATEWAY_URL = os.environ.get("JARVIS_GATEWAY_URL", "http://127.0.0.1:22100")
    completions_url = f"{GATEWAY_URL}/v1/chat/completions"
    model = os.environ.get("DIARIZE_MODEL", "claude")

    gateway_token = os.environ.get("JARVIS_GATEWAY_TOKEN", "")

    # Build transcript for Claude
    transcript_lines = []
    for s in segments:
        transcript_lines.append(f"[{s['start']}] {s['text']}")
    transcript_text = "\n".join(transcript_lines)

    prompt = f"""You are a speaker diarization system. You will be given a transcript with timestamps.
Your task is to assign speaker labels to each line based on context clues — conversational patterns, 
question/answer dynamics, tone, subject matter, and any other deducible signals.

{f'Context: {context_hint}' if context_hint else ''}
Number of speakers: {num_speakers if num_speakers else 'unknown — deduce from transcript'}

Transcript:
{transcript_text}

Return ONLY a JSON array, one object per transcript line, in this exact format:
[
  {{"index": 0, "speaker": "SPEAKER_A", "text": "..."}},
  ...
]

Rules:
- Use descriptive speaker names if inferable from context (e.g. "SHERLOCK", "WATSON", "HOST", "GUEST")
- Otherwise use SPEAKER_A, SPEAKER_B, etc.
- Every line must have a speaker
- Return valid JSON only, no other text"""

    payload = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        completions_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {gateway_token}"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())

    raw = data["choices"][0]["message"]["content"].strip()
    # Strip markdown code block if present
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    labeled = json.loads(raw)

    # Merge labels back with timestamps
    result = []
    for i, seg in enumerate(segments):
        label = labeled[i] if i < len(labeled) else {"speaker": "UNKNOWN", "text": seg["text"]}
        result.append({
            "start": seg["start"],
            "end": seg["end"],
            "speaker": label.get("speaker", "UNKNOWN"),
            "text": label.get("text", seg["text"])
        })
    return result

def format_output(diarized: list[dict], fmt: str = "pretty") -> str:
    """Format diarized output."""
    if fmt == "json":
        return json.dumps(diarized, indent=2)

    if fmt == "srt":
        lines = []
        for i, seg in enumerate(diarized, 1):
            lines.append(str(i))
            lines.append(f"{seg['start']} --> {seg['end']}")
            lines.append(f"[{seg['speaker']}] {seg['text']}")
            lines.append("")
        return "\n".join(lines)

    # Default: pretty console output
    lines = []
    prev_speaker = None
    for seg in diarized:
        speaker = seg["speaker"]
        if speaker != prev_speaker:
            lines.append(f"\n[{speaker}]")
            prev_speaker = speaker
        lines.append(f"  {seg['start']}  {seg['text']}")
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="Transcript-based speaker diarization")
    parser.add_argument("source", help="URL or audio file path")
    parser.add_argument("--speakers", type=int, default=0, help="Expected number of speakers (0=auto)")
    parser.add_argument("--context", default="", help="Hint about the audio (e.g. 'BBC interview, host and guest')")
    parser.add_argument("--format", choices=["pretty", "srt", "json"], default="pretty")
    parser.add_argument("--keep", action="store_true", help="Keep temp files")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        # Step 1: Get audio
        source = args.source
        if source.startswith("http://") or source.startswith("https://"):
            audio_path = download_audio(source, tmp)
        else:
            audio_path = source

        # Step 2: Transcribe
        srt_content = transcribe(audio_path, tmp)

        # Step 3: Parse SRT
        segments = parse_srt(srt_content)
        if not segments:
            print("❌ No segments found in transcript", file=sys.stderr)
            sys.exit(1)
        print(f"✅ {len(segments)} segments transcribed", file=sys.stderr)

        # Step 4: Diarize
        print("🧠 Deducing speakers from transcript context...", file=sys.stderr)
        diarized = diarize_with_claude(segments, args.speakers, args.context)

        # Step 5: Output
        print(format_output(diarized, args.format))

        if args.keep:
            print(f"\n📁 Temp files kept at: {tmp}", file=sys.stderr)

if __name__ == "__main__":
    main()
