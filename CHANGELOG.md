# Changelog

## [Unreleased]

### Fixed
- Pin torch>=2.6.0 in requirements.txt to avoid CUPTI symbol mismatch on CUDA 13.x drivers
- Add CPU fallback in whisper_stt_service.py when CUDA import or load fails
- Add `--device` CLI flag to whisper service for explicit CPU/GPU selection
- Increase RestartSec to 30s in service template; add StartLimitBurst=5 to prevent restart storms
- Use network-online.target (not network.target) in voice service template to fix DNS race on boot
- setup-gpu-env.sh: add --force flag for clean venv rebuild; improve CUDA diagnostic output; remove emoji
- stt.js: distinguish ECONNREFUSED (service down) from transcription errors in log output

### Added
- gpu-services/jarvis-voice.service — systemd service template (network-online.target, %h paths)
- gpu-services/jarvis-whisper-stt.service — systemd service template with restart limits
- Troubleshooting section in README covering CUPTI mismatch, restart storms, DNS race, and venv rebuild
