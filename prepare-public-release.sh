#!/bin/bash
# Prepare jarvis-voice for public release with clean git history
set -e

echo "⚠️  WARNING: This will rewrite git history!"
echo "Make sure you have a backup of the original repo."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Get the current branch name
CURRENT_BRANCH=$(git branch --show-current)
echo "📍 Current branch: $CURRENT_BRANCH"

# Create backup branch
BACKUP_BRANCH="${CURRENT_BRANCH}-backup-$(date +%Y%m%d-%H%M%S)"
echo "💾 Creating backup branch: $BACKUP_BRANCH"
git branch $BACKUP_BRANCH

# Create new orphan branch with clean history
echo "🌱 Creating clean history branch..."
git checkout --orphan clean-main

# Stage all files
echo "📦 Staging files..."
git add -A

# Create initial commit
echo "✍️  Creating initial commit..."
git commit -m "Initial public release

Jarvis: Real-time Discord voice assistant powered by Clawdbot

Features:
- Discord voice channel integration
- Real-time speech-to-text (Deepgram/Whisper)
- Conversational AI via Clawdbot gateway
- Wake word detection with conversation windows
- Streaming TTS for low-latency responses
- Dynamic response budgets based on intent classification
- Multi-context support for focused conversations

Architecture:
- Thin voice I/O layer (this bot)
- Clawdbot gateway (brain with full tool access)
- Modular STT/TTS providers
- Intent-driven response formatting

All personal data and internal project references have been removed.
This is a clean starting point for public distribution."

# Replace the old main/master branch
echo "🔄 Replacing $CURRENT_BRANCH branch..."
git branch -D $CURRENT_BRANCH 2>/dev/null || true
git branch -m $CURRENT_BRANCH

echo ""
echo "✅ Clean history created!"
echo ""
echo "📋 Summary:"
echo "  - Old branch backed up as: $BACKUP_BRANCH"
echo "  - Current branch ($CURRENT_BRANCH) now has clean history"
echo "  - Single commit: 'Initial public release'"
echo ""
echo "Next steps:"
echo "1. Review the changes: git log --oneline"
echo "2. If satisfied, force push to remote: git push origin $CURRENT_BRANCH --force"
echo "3. Or restore backup: git checkout $BACKUP_BRANCH && git branch -D $CURRENT_BRANCH && git branch -m $CURRENT_BRANCH"
echo ""
echo "⚠️  Remember: Never force push to a shared repository without coordinating with your team!"
