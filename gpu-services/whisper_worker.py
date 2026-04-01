import sys
import json
import logging
from faster_whisper import WhisperModel

# Minimal logging
logging.basicConfig(level=logging.ERROR)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio file provided"}))
        return

    wav_path = sys.argv[1]
    
    try:
        # load model once if this was a service, but for now we're fixing the CLI-style call
        model = WhisperModel("large-v3", device="cuda", compute_type="float16")
        segments, info = model.transcribe(wav_path, beam_size=5, language="en")
        text = " ".join(s.text.strip() for s in segments)
        
        print(json.dumps({
            "text": text,
            "language": info.language,
            "probability": info.language_probability
        }))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
