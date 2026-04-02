# Jarvis Voice Bot - Quick Setup

## Step 1: Create Discord Application (30 seconds)

1. Open: https://discord.com/developers/applications
2. Click **"New Application"**
3. Name: `Jarvis Voice`
4. Click **Create**

## Step 2: Configure Bot (30 seconds)

1. Go to **Bot** tab (left sidebar)
2. Click **"Reset Token"** → **Copy the token**
3. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent (optional)

## Step 3: Invite to Server (30 seconds)

1. Go to **OAuth2** → **URL Generator**
2. Check scopes: `bot`
3. Check permissions:
   - ✅ Connect
   - ✅ Speak  
   - ✅ Use Voice Activity
4. Copy the generated URL and open it in browser
5. Select your server → **Authorize**

Or use this template (replace YOUR_APP_ID with the Application ID from General Information):
```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=36700160&scope=bot
```

## Step 4: Paste Token

Edit `./jarvis-voice/.env`:
```
DISCORD_TOKEN=paste_your_token_here
```

## Step 5: Start

```bash
cd ./jarvis-voice
npm start
```

The bot will join the "Project Jarvis" voice channel automatically. Join the same channel and start talking!
