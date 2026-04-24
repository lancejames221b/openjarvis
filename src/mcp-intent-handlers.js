/**
 * mcp-intent-handlers.js — Pre-fetch MCP data before Claude runs.
 *
 * These handlers are the Option-2 implementation: when Haiku classifies a
 * voice command as calendar/gmail/notion/slack lookup, we call mcporter from
 * the Node layer directly (fast), then hand the gathered data to Claude as
 * pre-baked workspace context. Claude answers naturally without needing MCP
 * tools in its subprocess — which is why the spawned claude can stay MCP-free
 * (the perf optimization the gateway was built around).
 *
 * Pattern:
 *   haiku intent  →  handler here  →  mcpCall → format  →  workspaceContext  →  brain call
 *
 * Each handler returns a string (or null on failure) that will be prepended
 * to the user's transcript when dispatch returns `{ type: 'brain' }`.
 */

import { mcpCall } from './mcp-access.js';
import logger from './logger.js';

// Lance's Google Workspace email (matches the user's auto-memory rule)
const USER_EMAIL = process.env.GOOGLE_WORKSPACE_EMAIL || 'owner@example.com';

/**
 * Truncate a string to a max length with an ellipsis marker.
 */
function _clip(s, n = 2500) {
  if (!s) return '';
  return s.length > n ? s.substring(0, n) + '\n…(truncated)' : s;
}

/**
 * calendar_query — freebusy check, event listing, or general "what's on"
 * params: { person, timeStart, timeEnd, relativeDay }
 */
export async function handleCalendarQuery(params = {}) {
  const { person, timeStart, timeEnd, relativeDay } = params;
  try {
    // Two branches:
    // 1. Checking someone else's availability → query_freebusy
    // 2. Asking about own schedule → get_events
    if (person && (timeStart || timeEnd)) {
      // Resolve person to an email. For now, pass raw — google-workspace tool
      // handles name-to-email lookup if the person is in the directory.
      const result = await mcpCall('google-workspace', 'query_freebusy', {
        user_google_email: USER_EMAIL,
        calendar_ids: JSON.stringify([person]),
        time_min: timeStart || '',
        time_max: timeEnd || '',
      });
      return `[CALENDAR LOOKUP — ${person} freebusy]\n${_clip(result)}`;
    }
    // Default: get user's own events for the window
    const result = await mcpCall('google-workspace', 'get_events', {
      user_google_email: USER_EMAIL,
      time_min: timeStart || '',
      time_max: timeEnd || '',
      max_results: '10',
    });
    return `[CALENDAR — ${USER_EMAIL} events${relativeDay ? ' (' + relativeDay + ')' : ''}]\n${_clip(result)}`;
  } catch (err) {
    logger.warn(`[mcp-intent] calendar_query failed: ${err.message}`);
    return `[CALENDAR LOOKUP FAILED: ${err.message}]`;
  }
}

/**
 * gmail_check — search user's inbox
 * params: { from, subject, newerThan, unread }
 */
export async function handleGmailCheck(params = {}) {
  const { from, subject, newerThan, unread } = params;
  // Build a Gmail search query string
  const qParts = [];
  if (from) qParts.push(`from:${from}`);
  if (subject) qParts.push(`subject:${subject}`);
  if (newerThan) qParts.push(`newer_than:${newerThan}`);
  if (unread === true) qParts.push('is:unread');
  if (!qParts.length) qParts.push('newer_than:1d');
  const query = qParts.join(' ');

  try {
    const result = await mcpCall('google-workspace', 'search_gmail_messages', {
      user_google_email: USER_EMAIL,
      query,
      max_results: '8',
    });
    return `[GMAIL SEARCH — query: ${query}]\n${_clip(result)}`;
  } catch (err) {
    logger.warn(`[mcp-intent] gmail_check failed: ${err.message}`);
    return `[GMAIL SEARCH FAILED: ${err.message}]`;
  }
}

/**
 * notion_fetch — find and read a Notion page
 * params: { pageQuery, title }
 */
export async function handleNotionFetch(params = {}) {
  const { pageQuery, title } = params;
  const q = (title || pageQuery || '').trim();
  if (!q) return '[NOTION FETCH: no query provided]';

  try {
    // Search first to find the page
    const searchResult = await mcpCall('notion', 'notion-search', {
      query: q,
      query_type: 'internal',
    });

    // If search hit something, try to fetch the first result's content
    // The search result is text; pull the first URL and pass to notion-fetch
    const urlMatch = searchResult?.match(/https:\/\/[a-z0-9.-]*notion\.so\/[^\s"]+/i);
    if (urlMatch) {
      const fetchResult = await mcpCall('notion', 'notion-fetch', {
        urls: JSON.stringify([urlMatch[0]]),
      });
      return `[NOTION PAGE — ${q}]\n${_clip(fetchResult, 3000)}`;
    }
    return `[NOTION SEARCH — ${q}]\n${_clip(searchResult)}`;
  } catch (err) {
    logger.warn(`[mcp-intent] notion_fetch failed: ${err.message}`);
    return `[NOTION FETCH FAILED: ${err.message}]`;
  }
}

/**
 * notion_meeting — query meeting notes database
 * params: { titleQuery, days }
 */
export async function handleNotionMeeting(params = {}) {
  const { titleQuery, days = 14 } = params;

  try {
    const args = {};
    if (titleQuery) {
      args['filters'] = JSON.stringify({ title: { string_contains: titleQuery } });
    }
    const result = await mcpCall('notion', 'notion-query-meeting-notes', args);
    return `[NOTION MEETING NOTES${titleQuery ? ' — "' + titleQuery + '"' : ' — recent'}]\n${_clip(result, 3000)}`;
  } catch (err) {
    logger.warn(`[mcp-intent] notion_meeting failed: ${err.message}`);
    return `[NOTION MEETING SEARCH FAILED: ${err.message}]`;
  }
}

/**
 * slack_search — search messages across Slack workspaces
 * params: { query, channel, from }
 */
export async function handleSlackSearch(params = {}) {
  const { query, channel, from } = params;
  const qParts = [];
  if (query) qParts.push(query);
  if (from) qParts.push(`from:@${from}`);
  if (channel) qParts.push(`in:#${channel}`);
  const q = qParts.join(' ').trim();
  if (!q) return '[SLACK SEARCH: no query provided]';

  try {
    const result = await mcpCall('slack', 'conversations_search_messages', {
      query: q,
      count: '8',
    });
    return `[SLACK SEARCH — ${q}]\n${_clip(result)}`;
  } catch (err) {
    logger.warn(`[mcp-intent] slack_search failed: ${err.message}`);
    return `[SLACK SEARCH FAILED: ${err.message}]`;
  }
}

/**
 * Map from intent name → handler function. Used by command-dispatch.
 */
export const MCP_INTENT_HANDLERS = {
  calendar_query: handleCalendarQuery,
  gmail_check:    handleGmailCheck,
  notion_fetch:   handleNotionFetch,
  notion_meeting: handleNotionMeeting,
  slack_search:   handleSlackSearch,
};

/**
 * Dispatch a single MCP intent. Returns the workspaceContext string,
 * or null if no handler is registered for the intent.
 */
export async function dispatchMcpIntent(intent, params) {
  const handler = MCP_INTENT_HANDLERS[intent];
  if (!handler) return null;
  logger.info(`[mcp-intent] ${intent} params=${JSON.stringify(params)}`);
  return await handler(params);
}
