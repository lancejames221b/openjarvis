#!/bin/bash
set -e
echo "Starting jarvis-voice dev environment..."
if [ ! -f .env ]; then
  cp .env.dev .env
  echo "Created .env from template. Edit it and add your Discord token, then re-run."
  exit 0
fi
docker compose -f docker-compose.dev.yml up --build "$@"
