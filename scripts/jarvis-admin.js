#!/usr/bin/env node
/**
 * jarvis-admin — manage per-channel Claude account profiles
 *
 * Usage:
 *   node scripts/jarvis-admin.js list
 *   node scripts/jarvis-admin.js add-profile <name> --config-dir <path> [--label <text>] --i-understand
 *   node scripts/jarvis-admin.js remove-profile <name>
 *   node scripts/jarvis-admin.js map-channel <channelKey> <profileName>
 *   node scripts/jarvis-admin.js unmap-channel <channelKey>
 *   node scripts/jarvis-admin.js reload   # POST /admin/reload-accounts to running gateway
 */

import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.HOME + "/.local/state/jarvis-voice";
const ACCOUNTS_PATH = process.env.CHANNEL_ACCOUNTS_PATH || `${STATE_DIR}/channel-accounts.json`;
const GATEWAY_URL = process.env.JARVIS_GATEWAY_URL || process.env.CLAWDBOT_GATEWAY_URL || "http://127.0.0.1:22100";
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN || "";

const POLICY = `
IMPORTANT — Per-Account Policy:
  Each channel profile must be authenticated with credentials legitimately held
  by the humans using that channel. Acceptable sources:
    ✓ Your own Claude Max subscription
    ✓ Your own Claude Teams seat
    ✓ A Teams seat legitimately held by the guest (they log in themselves)
    ✓ The guest's own Anthropic API key
    ✗ Sharing one Max account with another human (violates Anthropic ToS)

  To authenticate a new profile directory:
    CLAUDE_CONFIG_DIR=~/.claude-<name> claude login
  The guest should perform this step themselves on this machine.
`;

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch {
    return { profiles: { default: { configDir: null, label: "primary (process owner)" } }, channels: {} };
  }
}

function saveAccounts(data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Saved: ${ACCOUNTS_PATH}`);
}

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function hasFlag(flag) {
  return args.includes(flag);
}

switch (cmd) {
  case "list": {
    const data = loadAccounts();
    console.log("\n=== Profiles ===");
    for (const [name, p] of Object.entries(data.profiles || {})) {
      const credPath = p.configDir ? `${p.configDir}/.credentials.json` : "~/.claude/.credentials.json (default)";
      const exists = p.configDir ? fs.existsSync(`${p.configDir}/.credentials.json`) : true;
      console.log(`  ${name}: ${p.label || "(no label)"} | configDir: ${p.configDir || "(default)"} | creds: ${exists ? "✓" : "✗ MISSING"}`);
    }
    console.log("\n=== Channel Mappings ===");
    const channels = data.channels || {};
    if (Object.keys(channels).length === 0) {
      console.log("  (none — all channels use the default profile)");
    } else {
      for (const [ch, profile] of Object.entries(channels)) {
        console.log(`  ${ch} → ${profile}`);
      }
    }
    break;
  }

  case "add-profile": {
    const name = args[1];
    const configDir = getFlag("--config-dir");
    const label = getFlag("--label") || name;

    if (!name || !configDir) {
      console.error("Usage: add-profile <name> --config-dir <path> [--label <text>] --i-understand");
      process.exit(1);
    }
    if (!hasFlag("--i-understand")) {
      console.log(POLICY);
      console.error("Add --i-understand to confirm you have read the policy above.");
      process.exit(1);
    }

    const resolvedDir = configDir.replace(/^~/, process.env.HOME);
    const credFile = `${resolvedDir}/.credentials.json`;
    if (!fs.existsSync(credFile)) {
      console.warn(`Warning: ${credFile} does not exist.`);
      console.warn(`The guest must first authenticate: CLAUDE_CONFIG_DIR=${resolvedDir} claude login`);
    }

    const data = loadAccounts();
    data.profiles[name] = { configDir: resolvedDir, label };
    saveAccounts(data);
    console.log(`Profile '${name}' added. configDir: ${resolvedDir}`);
    break;
  }

  case "remove-profile": {
    const name = args[1];
    if (!name || name === "default") {
      console.error("Cannot remove the 'default' profile. Provide a non-default profile name.");
      process.exit(1);
    }
    const data = loadAccounts();
    if (!data.profiles[name]) {
      console.error(`Profile '${name}' not found.`);
      process.exit(1);
    }
    delete data.profiles[name];
    // Remove any channel mappings pointing to this profile
    for (const [ch, p] of Object.entries(data.channels || {})) {
      if (p === name) delete data.channels[ch];
    }
    saveAccounts(data);
    console.log(`Profile '${name}' removed.`);
    break;
  }

  case "map-channel": {
    const channelKey = args[1];
    const profileName = args[2];
    if (!channelKey || !profileName) {
      console.error("Usage: map-channel <channelKey> <profileName>");
      process.exit(1);
    }
    const data = loadAccounts();
    if (!data.profiles[profileName]) {
      console.error(`Profile '${profileName}' not found. Run 'list' to see available profiles.`);
      process.exit(1);
    }
    data.channels[channelKey] = profileName;
    saveAccounts(data);
    console.log(`Channel '${channelKey}' → profile '${profileName}'`);
    break;
  }

  case "unmap-channel": {
    const channelKey = args[1];
    if (!channelKey) {
      console.error("Usage: unmap-channel <channelKey>");
      process.exit(1);
    }
    const data = loadAccounts();
    delete data.channels[channelKey];
    saveAccounts(data);
    console.log(`Channel '${channelKey}' mapping removed (will use default profile).`);
    break;
  }

  case "reload": {
    if (!GATEWAY_TOKEN) {
      console.error("JARVIS_GATEWAY_TOKEN not set in environment — cannot authenticate to gateway.");
      process.exit(1);
    }
    fetch(`${GATEWAY_URL}/admin/reload-accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
    }).then(async r => {
      const body = await r.json();
      console.log(`Gateway response (${r.status}):`, JSON.stringify(body, null, 2));
    }).catch(e => {
      console.error(`Failed to reach gateway at ${GATEWAY_URL}:`, e.message);
      process.exit(1);
    });
    break;
  }

  default:
    console.log(`
jarvis-admin — manage per-channel Claude account profiles

Commands:
  list                                       Show all profiles and channel mappings
  add-profile <name> --config-dir <path>     Add a new account profile (requires --i-understand)
    [--label <text>] --i-understand
  remove-profile <name>                      Remove a profile and its channel mappings
  map-channel <channelKey> <profileName>     Route a Discord channel to a profile
  unmap-channel <channelKey>                 Remove a channel mapping (reverts to default)
  reload                                     Hot-reload accounts into running gateway

Example:
  CLAUDE_CONFIG_DIR=~/.claude-alex claude login
  node scripts/jarvis-admin.js add-profile alex --config-dir ~/.claude-alex --label "Alex Teams seat" --i-understand
  node scripts/jarvis-admin.js map-channel channel:1234567890 alex
  node scripts/jarvis-admin.js reload
`);
}
