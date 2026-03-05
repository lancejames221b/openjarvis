/**
 * Agent Delegation System
 * 
 * Determines when voice tasks should be delegated to background agents
 * and spawns them via Clawdbot Gateway.
 * 
 * The philosophy: Voice Jarvis is fast acknowledgment + handoff.
 * Background agents do the heavy lifting and post results to text channel.
 */

import 'dotenv/config';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;

// Tool-trigger keywords that suggest heavy tool use
const TOOL_KEYWORDS = [
  'email', 'inbox', 'calendar', 'schedule', 'search', 'find', 'look up',
  'analyze', 'review', 'check', 'investigate', 'research', 'explore',
  'list', 'show me', 'give me', 'what are', 'what\'s on',
  'archive', 'cleanup', 'organize', 'delete', 'move',
  'post', 'send', 'message', 'notify', 'alert',
  'deploy', 'build', 'implement', 'migrate', 'configure', 'install',
  'generate', 'compile', 'document', 'validate', 'verify',
  'monitor', 'track', 'sync', 'push', 'pull', 'commit',
  'design', 'schema', 'refactor', 'debug', 'fix',
  'study', 'plan', 'todo', 'exec', 'admin',
];

/**
 * Determine if a task should be delegated to a background agent
 * 
 * @param {string} transcript - User's speech
 * @param {string} intentType - Intent classification result (ACTION, LIST_QUERY, etc.)
 * @returns {boolean} True if should delegate
 */
export function shouldDelegate(transcript, intentType) {
  // Delegation disabled — voice bot is a thin pipe, all work goes through gateway streaming.
  // The gateway agent handles tool calls internally. No need to spawn separate background agents.
  // See: Feb 15, 2026 — hooks.allowRequestSessionKey=false, delegation always fails.
  return false;
}

/**
 * Spawn a background agent to handle a task
 * 
 * @param {string} task - User's original request
 * @param {Object|null} activeContext - Current channel context if any
 * @param {string} outputChannel - Discord channel ID to post results
 * @returns {Promise<{sessionKey: string, timestamp: number}|null>}
 */
export async function spawnBackgroundAgent(task, activeContext, outputChannel) {
  if (!GATEWAY_TOKEN) {
    console.error('❌ CLAWDBOT_GATEWAY_TOKEN not set, cannot spawn agent');
    return null;
  }
  
  try {
    const timestamp = Date.now();
    const label = `jarvis-voice-task:${timestamp}`;
    
    // Build task message with context
    let taskMessage = `You are a background agent spawned by Jarvis Voice to handle a task.

User request: "${task}"`;

    // Add active context if present
    if (activeContext && activeContext.directive) {
      taskMessage += `

Active context: ${activeContext.channelName}

Channel directive (excerpt):
${activeContext.directive.substring(0, 1500)}

Work within this context. Use all available tools and knowledge relevant to this focus area.`;
    }

    // Add instructions
    taskMessage += `

Instructions:
1. Execute the task using all available tools (email, calendar, search, MCP, web, etc.)
2. Be thorough — this is background work, not voice-constrained
3. When complete, post a concise summary to Discord channel ${outputChannel} using the message tool
4. Format your summary as:
   - **What was done:** Brief description of actions taken
   - **Key results:** Important findings or outcomes
   - **Action items:** Follow-up needed (if any)
5. AFTER posting to Discord, trigger a voice alert by running this command:
   curl -X POST http://\${TAILSCALE_IP}:3335/alert -H "Authorization: Bearer \${ALERT_WEBHOOK_TOKEN}" -H "Content-Type: application/json" -d '{"message":"Task complete: [one-line summary]","priority":"normal","fullDetails":"[full summary from Discord post]","source":"background-agent"}'

Do not narrate your process. Just do the work and report results.`;

    console.log(`🚀 Spawning background agent with label: ${label}`);
    console.log(`📤 Output channel: ${outputChannel}`);
    console.log(`📝 Task: "${task}"`);
    
    // Spawn agent via Gateway hook endpoint
    // Use fire-and-forget: agent will post results when done
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for spawn
    
    const res = await fetch(`${GATEWAY_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        message: taskMessage,
        name: 'JarvisVoiceDelegation',
        sessionKey: `hook:jarvis-voice:task:${timestamp}`,
        deliver: true,
        channel: 'discord', // Channel type (results post to last active Discord)
        wakeMode: 'now',
        model: 'clawdbot:main', // Use main agent (full tool access)
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`❌ Agent spawn failed: ${res.status} ${errorBody}`);
      return null;
    }
    
    const data = await res.json();
    console.log(`✅ Background agent spawned successfully`);
    console.log(`📊 Session: hook:jarvis-voice:task:${timestamp}`);
    
    return {
      sessionKey: `hook:jarvis-voice:task:${timestamp}`,
      timestamp,
    };
    
  } catch (err) {
    console.error('❌ Failed to spawn background agent:', err.message);
    return null;
  }
}

/**
 * Poll for agent completion and return result when done
 * 
 * @param {string} sessionKey - Agent session key to poll
 * @param {number} timeoutMs - Max time to poll (default 60s)
 * @returns {Promise<{completed: boolean, response: string|null}>}
 */
export async function pollAgentCompletion(sessionKey, timeoutMs = 60000) {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check agent session status via Gateway
      const res = await fetch(`${GATEWAY_URL}/api/sessions/${encodeURIComponent(sessionKey)}`, {
        headers: {
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        },
      });
      
      if (!res.ok) {
        console.log(`⏳ Agent session not found yet (${res.status}), waiting...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      
      // Parse JSON response
      let session;
      try {
        session = await res.json();
      } catch (parseErr) {
        console.log(`⏳ Agent session not ready (invalid response), waiting...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      
      // Check if agent has sent messages (completed)
      if (session.messages && session.messages.length > 0) {
        const lastMessage = session.messages[session.messages.length - 1];
        if (lastMessage.role === 'assistant') {
          console.log(`✅ Agent completed!`);
          
          // Extract text content from last message
          let responseText = '';
          if (lastMessage.content) {
            for (const block of lastMessage.content) {
              if (block.type === 'text') {
                responseText += block.text + ' ';
              }
            }
          }
          
          return { completed: true, response: responseText.trim() };
        }
      }
      
      // Not done yet, wait and poll again
      console.log(`⏳ Agent still working...`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
    } catch (err) {
      console.error(`⚠️  Poll error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }
  
  // Timeout
  console.log(`⏱️  Agent poll timeout after ${timeoutMs}ms`);
  return { completed: false, response: null };
}

/**
 * Extract TL;DR (first 2-3 sentences) from agent response
 * 
 * @param {string} text - Full agent response
 * @returns {string} TL;DR summary
 */
export function extractTLDR(text) {
  if (!text) return 'Agent completed.';
  
  // Split into sentences
  const sentences = text
    .split(/[.!?]+\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  // Take first 2-3 sentences, max ~150 chars for voice
  let tldr = '';
  let count = 0;
  
  for (const sentence of sentences) {
    if (count >= 3 || tldr.length + sentence.length > 150) break;
    tldr += sentence + '. ';
    count++;
  }
  
  return tldr.trim() || 'Agent completed.';
}
