/**
 * Voice State Persistence
 * 
 * Tracks conversational context across voice interactions.
 * When the user says "that thread" or "the channel", we resolve
 * from this state tracker instead of forcing them to repeat.
 */

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const voiceState = {
  lastMentionedThread: null,
  lastMentionedChannel: null,
  lastMentionedFile: null,
  lastTopic: null,
  updatedAt: null,
};

/**
 * Update voice state with extracted entities
 */
export function updateVoiceState(updates) {
  Object.assign(voiceState, updates, { updatedAt: Date.now() });
  console.log('📍 Voice state updated:', voiceState);
}

/**
 * Get current voice state as context string
 */
export function getVoiceStateContext() {
  if (!voiceState.updatedAt) return '';
  
  const age = Date.now() - voiceState.updatedAt;
  if (age > STATE_TTL_MS) {
    console.log('⏰ Voice state expired, clearing');
    clearVoiceState();
    return '';
  }
  
  const parts = [];
  if (voiceState.lastMentionedThread)
    parts.push(`Last thread: ${voiceState.lastMentionedThread}`);
  if (voiceState.lastMentionedChannel)
    parts.push(`Last channel: ${voiceState.lastMentionedChannel}`);
  if (voiceState.lastMentionedFile)
    parts.push(`Last file: ${voiceState.lastMentionedFile}`);
  if (voiceState.lastTopic)
    parts.push(`Last topic: ${voiceState.lastTopic}`);
  
  if (parts.length === 0) return '';
  
  return `Voice session state - ${parts.join(', ')}`;
}

/**
 * Clear expired state
 */
export function clearVoiceState() {
  voiceState.lastMentionedThread = null;
  voiceState.lastMentionedChannel = null;
  voiceState.lastMentionedFile = null;
  voiceState.lastTopic = null;
  voiceState.updatedAt = null;
}

/**
 * Extract entities from bot response and update state
 */
export function extractAndUpdateState(response) {
  const updates = {};
  
  // Thread references: "thread 1234" or "the dev-discussion thread"
  const threadMatch = response.match(/thread[:\s]+([a-zA-Z0-9-]+)/i);
  if (threadMatch) updates.lastMentionedThread = threadMatch[1];
  
  // Channel references: "in #general" or "channel 1234"
  const channelMatch = response.match(/(?:in\s+)?#([a-zA-Z0-9-]+)|channel[:\s]+([0-9]+)/i);
  if (channelMatch) updates.lastMentionedChannel = channelMatch[1] || channelMatch[2];
  
  // File references: "file.txt" or "the config file"
  const fileMatch = response.match(/(?:file|document)[:\s]+([a-zA-Z0-9._-]+)/i);
  if (fileMatch) updates.lastMentionedFile = fileMatch[1];
  
  // Topic extraction: first sentence/clause as rough topic indicator
  const firstSentence = response.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length > 10 && firstSentence.length < 100) {
    updates.lastTopic = firstSentence.trim();
  }
  
  if (Object.keys(updates).length > 0) {
    updateVoiceState(updates);
  }
}
