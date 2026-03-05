# roku-control — Setup

## Find Your Roku IP Addresses

```bash
# Option 1: Roku app on phone → Settings → Player Info → IP address
# Option 2: Router DHCP table — look for "Roku" devices
# Option 3: Network scan
nmap -sn 192.168.1.0/24 | grep -i roku
```

## Verify Roku ECP Access

```bash
curl http://YOUR_ROKU_IP:8060/device-info
```

Should return XML with device details. If it times out, check your firewall.

## Configure Rooms

Edit your skill config or set environment variables:

```bash
# Single Roku setup
ROKU_DEFAULT_IP=192.168.1.XX

# Multi-room setup (name → IP mapping)
ROKU_ROOMS='{
  "projector": "192.168.1.XX",
  "bedroom": "192.168.1.XX",
  "living room": "192.168.1.XX"
}'

# Or configure individual room env vars
ROKU_PROJECTOR_IP=192.168.1.XX
ROKU_BEDROOM_IP=192.168.1.XX
ROKU_LIVINGROOM_IP=192.168.1.XX
```

## Get App Channel IDs

```bash
# List all installed apps on a Roku
curl http://YOUR_ROKU_IP:8060/query/apps

# Common channel IDs:
# Plex:      2285
# Netflix:   12
# Disney+:   rokuexpress_disneyplus
# Hulu:      2285
# YouTube:   tvinput.hdmi1 (varies)
```

Set your most-used app IDs:
```bash
ROKU_PLEX_CHANNEL_ID=2285
ROKU_NETFLIX_CHANNEL_ID=12
```

## Test

```bash
# Pause the default Roku
curl -X POST http://YOUR_ROKU_IP:8060/keypress/Pause

# Then in OpenClaw: "Jarvis, pause the TV"
```
