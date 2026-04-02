---
name: plex-media
description: Add movies and TV shows to Plex media library via qBittorrent. Use when requesting media downloads for Plex. Handles search, quality selection, download automation, and library organization.
tier: JARVIS
triggers:
  - "download X"
  - "get me X"
  - "add X to Plex"
  - "find X for Plex"
  - "download season X of Y"
  - "get the latest episode of"
  - "I want to watch X"
  - "put X on Plex"
---

# plex-media — Media on Demand

Ask for a movie or show. Jarvis finds it, downloads it, drops it in Plex.

> "Jarvis, get me Dune Part Two."  
> "Add Season 3 of Severance to Plex."  
> "Download the latest episode of The Bear."

## How It Works

1. Searches configured torrent indexers for the requested title
2. Filters for your preferred quality (default: 1080p, then 4K if available)
3. Adds the torrent to qBittorrent via its WebUI API
4. Monitors download progress
5. On completion: moves to the correct Plex library path (Movies/ or TV Shows/)
6. Triggers a Plex library scan via the Plex API

## Quality Preferences

Configurable priority order:
1. 4K HDR (if your setup supports it)
2. 1080p (default)
3. 720p (fallback)
4. Prefers: x265/HEVC for storage efficiency, x264 for compatibility

Avoid: CAM, TS, DVDScr, R5 (auto-filtered)

## Confirmation Flow

Before downloading, Jarvis confirms:

> "Found Dune Part Two — 1080p, 15.2GB. Add it?"

For TV shows:
> "Severance Season 3 has 10 episodes. Download all? Or specific episodes?"

## Progress Updates

Jarvis can report download progress on request:
> "How's the Dune download?"  
> *"About 60% done — 6GB of 15GB, should finish in about 20 minutes."*

## Setup

See `SETUP.md` for qBittorrent WebUI config and Plex API token.

**Note:** This skill assumes you have the legal right to download the content you request. Only use it for content you own or have a license for.
