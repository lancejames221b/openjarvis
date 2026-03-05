/**
 * Channel Router - Voice Channel Mobility + Context Switching
 * 
 * Detects channel commands in voice transcripts and handles:
 * - Voice channel movement (physical location change)
 * - Context switching (loading different channel directives)
 * - Channel queries (where am I, what contexts are available)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { joinVoiceChannel } from '@discordjs/voice';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Voice command patterns
const MOVE_PATTERNS = [
  /\b(?:go to|move to|join|come to)\s+(?:the\s+)?(.+?)(?:\s+channel|\s+voice)?$/i,
];

const FOCUS_PATTERNS = [
  /\b(?:focus on|switch to)\s+(?:the\s+)?(\w+(?:\s+\w+)?)$/i,  // Max 2 words
  /\b(?:jarvis)\s+(\w+)$/i,  // "jarvis security", "jarvis gibson"
];

const QUERY_PATTERNS = [
  /\b(?:where am i|what context|what channel|which channel)\b/i,
  /\b(?:what channels are available|list channels|show channels)\b/i,
];

/**
 * Detect channel command in transcript
 * @param {string} transcript - The user's speech
 * @returns {{ action: 'move'|'focus'|'query'|null, target: string|null, raw: string }}
 */
export function detectChannelCommand(transcript) {
  const lower = transcript.toLowerCase().trim();
  
  // Check for query commands first (no target needed)
  for (const pattern of QUERY_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        action: 'query',
        target: null,
        raw: transcript,
      };
    }
  }
  
  // Check for move commands
  for (const pattern of MOVE_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      return {
        action: 'move',
        target: match[1].trim(),
        raw: transcript,
      };
    }
  }
  
  // Check for focus commands
  for (const pattern of FOCUS_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      return {
        action: 'focus',
        target: match[1].trim(),
        raw: transcript,
      };
    }
  }
  
  return { action: null, target: null, raw: transcript };
}

/**
 * Resolve channel name or alias to channel entry
 * @param {string} nameOrAlias - User's channel reference
 * @param {Object} registry - Channel registry object
 * @returns {{ channelId: string, channelName: string, directivePath: string|null, voiceChannelId: string|null }|null}
 */
export function resolveChannel(nameOrAlias, registry) {
  if (!nameOrAlias || !registry) return null;
  
  const query = nameOrAlias.toLowerCase().trim();
  
  // Check Discord channels
  if (registry.discord) {
    for (const [channelId, data] of Object.entries(registry.discord)) {
      // Match channel name
      if (data.name && data.name.toLowerCase() === query) {
        return {
          channelId,
          channelName: data.name,
          directivePath: data.directive || null,
          voiceChannelId: data.voiceChannelId || null,
        };
      }
      
      // Match aliases
      if (data.aliases && Array.isArray(data.aliases)) {
        const matched = data.aliases.some(alias => 
          alias.toLowerCase() === query
        );
        if (matched) {
          return {
            channelId,
            channelName: data.name,
            directivePath: data.directive || null,
            voiceChannelId: data.voiceChannelId || null,
          };
        }
      }
    }
  }
  
  // Check voice channels section
  if (registry.voiceChannels) {
    for (const [voiceChannelId, data] of Object.entries(registry.voiceChannels)) {
      if (data.name && data.name.toLowerCase() === query) {
        // Resolve the default context if it exists
        let directivePath = null;
        let textChannelId = null;
        
        if (data.defaultContext && registry.discord) {
          // Find the text channel entry for this context
          for (const [chanId, chanData] of Object.entries(registry.discord)) {
            if (chanData.name === data.defaultContext) {
              textChannelId = chanId;
              directivePath = chanData.directive || null;
              break;
            }
          }
        }
        
        return {
          channelId: textChannelId,
          channelName: data.name,
          directivePath,
          voiceChannelId,
        };
      }
    }
  }
  
  return null;
}

/**
 * Load channel directive from disk
 * @param {string} directivePath - Path to directive file (relative to repo root)
 * @returns {string|null} Truncated directive content (~2000 chars)
 */
export function loadDirective(directivePath) {
  if (!directivePath) return null;
  
  try {
    // Resolve path relative to repo root
    const repoRoot = join(__dirname, '..', '..');
    const fullPath = join(repoRoot, directivePath);
    
    const content = readFileSync(fullPath, 'utf8');
    
    // Truncate to ~2000 chars, focus on key sections
    // Extract purpose, active work, key rules
    const lines = content.split('\n');
    const importantSections = [];
    let inImportantSection = false;
    let charCount = 0;
    const MAX_CHARS = 2000;
    
    for (const line of lines) {
      // Detect important sections
      if (line.match(/^##\s+(Purpose|Mission|Active|Responsibilities|Tools|Standing Orders)/i)) {
        inImportantSection = true;
      } else if (line.startsWith('##')) {
        inImportantSection = false;
      }
      
      if (inImportantSection || line.startsWith('#')) {
        if (charCount + line.length > MAX_CHARS) break;
        importantSections.push(line);
        charCount += line.length + 1; // +1 for newline
      }
    }
    
    let truncated = importantSections.join('\n');
    
    // If we didn't get anything from section filtering, just take first 2000 chars
    if (truncated.length < 200) {
      truncated = content.substring(0, MAX_CHARS);
    }
    
    return truncated;
  } catch (err) {
    console.error(`Failed to load directive ${directivePath}:`, err.message);
    return null;
  }
}

/**
 * Move Jarvis to a different voice channel
 * @param {import('discord.js').Client} client - Discord client
 * @param {string} guildId - Guild ID
 * @param {string} targetVoiceChannelId - Target voice channel ID
 * @returns {Promise<import('@discordjs/voice').VoiceConnection>}
 */
export async function moveToVoiceChannel(client, guildId, targetVoiceChannelId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found`);
  
  const channel = guild.channels.cache.get(targetVoiceChannelId);
  if (!channel) throw new Error(`Voice channel ${targetVoiceChannelId} not found`);
  
  const connection = joinVoiceChannel({
    channelId: targetVoiceChannelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  
  return connection;
}
