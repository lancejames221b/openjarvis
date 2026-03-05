#!/usr/bin/env python3
"""
Vosk STT wrapper - fast local speech recognition
Usage: vosk-stt.py <wav_file>
"""
import os
import sys
import json
import wave
from vosk import Model, KaldiRecognizer

MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "vosk", "vosk-model-small-en-us-0.15"))

def transcribe(wav_path):
    wf = wave.open(wav_path, "rb")
    if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() not in [8000, 16000, 22050, 44100, 48000]:
        print(f"ERROR: Audio must be mono PCM", file=sys.stderr)
        sys.exit(1)
    
    model = Model(MODEL_PATH)
    rec = KaldiRecognizer(model, wf.getframerate())
    rec.SetWords(True)
    
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        rec.AcceptWaveform(data)
    
    result = json.loads(rec.FinalResult())
    print(result.get("text", ""))

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: vosk-stt.py <wav_file>", file=sys.stderr)
        sys.exit(1)
    transcribe(sys.argv[1])
