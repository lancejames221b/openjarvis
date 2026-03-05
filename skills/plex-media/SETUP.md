# plex-media — Setup

## Requirements

- qBittorrent with WebUI enabled
- Plex Media Server running
- Configured media directories (Movies/, TV Shows/)

## qBittorrent WebUI

Enable in qBittorrent: Tools → Preferences → Web UI → Enable Web User Interface

```bash
QBIT_URL=http://localhost:8080
QBIT_USERNAME=admin
QBIT_PASSWORD=your_password
```

## Plex API Token

Get your Plex token:
1. Sign into Plex Web
2. Open any media item → Get Info → View XML
3. Look for `X-Plex-Token` in the URL

```bash
PLEX_URL=http://localhost:32400
PLEX_TOKEN=your_token_here
```

## Media Directories

```bash
PLEX_MOVIES_DIR=/path/to/Movies
PLEX_TV_DIR=/path/to/TV Shows
```

These must match what Plex has configured as library paths.

## Torrent Indexers

Configure your preferred indexer(s). The skill uses whatever search API you point it at. Common options: Prowlarr (recommended — aggregates multiple indexers), Jackett, or direct indexer APIs.

```bash
PROWLARR_URL=http://localhost:9696
PROWLARR_API_KEY=your_key
```

## Quality Preferences

```bash
PREFERRED_QUALITY=1080p      # 2160p, 1080p, 720p
PREFER_CODEC=x265            # x265, x264 (x265 = smaller files)
MAX_SIZE_GB=50               # Skip anything larger than this
```

## Test

> "Jarvis, download a test movie."  
> Jarvis should confirm with title, quality, and size before downloading.
