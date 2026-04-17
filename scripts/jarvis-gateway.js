import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.ZEROCLAW_COMPAT_PORT || 22103);
const ZEROCLAW_BASE_URL = process.env.ZEROCLAW_BASE_URL || "http://127.0.0.1:22101";
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN || "";
// Shell aliases (like `claude --dangerously-skip-permissions`) don't survive spawn().
// Use the actual binary path and pass flags explicitly.
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;
// Logical model aliases — map short names to Anthropic model IDs.
const MODEL_ALIASES = {
  claude:  process.env.DISPATCH_MODEL      || "claude-sonnet-4-6",
  sonnet:  process.env.DISPATCH_MODEL      || "claude-sonnet-4-6",
  opus:    process.env.DISPATCH_MODEL_DEEP || "claude-opus-4-7",
  haiku:   "claude-haiku-4-5-20251001",
};
const CLAUDE_MODEL_RE = /^claude-/;
function resolveModel(raw) {
  if (!raw) return "";
  const m = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, m)) return MODEL_ALIASES[m];
  if (CLAUDE_MODEL_RE.test(m)) return m;
  return "";
}
const DEFAULT_CLAUDE_MODEL = resolveModel(process.env.DISPATCH_MODEL) || "claude-sonnet-4-6";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DEFAULT_REPORT_CHANNEL = process.env.DISCORD_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID || "";
const ALERT_WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || "";
const ALERT_WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || "3335";
const ALERT_WEBHOOK_HOST = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || "127.0.0.1";
const SPEAK_URL = process.env.ZEROCLAW_COMPAT_SPEAK_URL || `http://${ALERT_WEBHOOK_HOST}:${ALERT_WEBHOOK_PORT}/speak`;
// Persist sessions to ~/.local/state so chatIds survive service restarts and reboots.
// /tmp is wiped on reboot; every restart meant fresh cursor-agent contexts.
const _defaultSessionDir = `${process.env.HOME}/.local/state/jarvis-voice`;
const SESSION_STORE_PATH = process.env.SESSION_STORE_PATH || `${_defaultSessionDir}/zeroclaw-sessions.json`;
const CHANNEL_ACCOUNTS_PATH = process.env.CHANNEL_ACCOUNTS_PATH || `${_defaultSessionDir}/channel-accounts.json`;
// Ensure the state directory exists (harmless if already present)
try { fs.mkdirSync(_defaultSessionDir, { recursive: true }); } catch {}
const CURSOR_AGENT_TIMEOUT_MS = 600_000; // 10 min — matches GATEWAY_TIMEOUT_MS in jarvis-voice

// ── Per-channel account profiles ─────────────────────────────────────────────
// Maps channels to separate CLAUDE_CONFIG_DIR paths for multi-account routing.
// Each configDir must be pre-authenticated via: CLAUDE_CONFIG_DIR=<path> claude login
function loadChannelAccounts() {
  try {
    return JSON.parse(fs.readFileSync(CHANNEL_ACCOUNTS_PATH, "utf8"));
  } catch {
    return { profiles: { default: { configDir: null, label: "primary (process owner)" } }, channels: {} };
  }
}
let channelAccounts = loadChannelAccounts();

function resolveProfile(channelKey) {
  if (!channelKey) return channelAccounts.profiles?.default ?? null;
  const profileName = channelAccounts.channels?.[channelKey] || "default";
  return channelAccounts.profiles?.[profileName] ?? channelAccounts.profiles?.default ?? null;
}

function validateProfiles() {
  const profiles = channelAccounts.profiles || {};
  let valid = 0; let invalid = 0;
  for (const [name, p] of Object.entries(profiles)) {
    if (!p.configDir) { valid++; continue; }
    try {
      fs.accessSync(`${p.configDir}/.credentials.json`, fs.constants.R_OK);
      valid++;
    } catch {
      log("profile_warn", { profile: name, configDir: p.configDir, msg: "credentials not found — run: CLAUDE_CONFIG_DIR=<path> claude login" });
      invalid++;
    }
  }
  return { total: Object.keys(profiles).length, valid, invalid };
}

// ── Metrics counters ─────────────────────────────────────────────────────────
const metrics = {
  requests: 0,
  requestsStreaming: 0,
  timeouts: 0,
  errors: 0,
  sessionsCreated: 0,
  sessionsResumed: 0,
  sessionsRotated: 0,
  hooksAgent: 0,
  rssKills: 0,
  clientAborts: 0,
};

// ── Session persistence ───────────────────────────────────────────────────────
// channelSessions persists across service restarts via a JSON file.
// On restart, cursor-agent silently starts fresh context if a UUID is stale.
function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8"))));
  } catch {
    return new Map();
  }
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(Object.fromEntries(channelSessions)));
  } catch (e) { log("session_save_warn", { path: SESSION_STORE_PATH, error: e.message }); }
}

const channelSessions = loadSessions();
// Per-channel turn counters (persisted alongside sessions in SESSION_STORE_PATH)
function loadJsonFile(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return {}; }
}
const channelTurns = new Map(Object.entries(loadJsonFile(SESSION_STORE_PATH + ".turns")));
function saveTurns() {
  try { fs.writeFileSync(SESSION_STORE_PATH + ".turns", JSON.stringify(Object.fromEntries(channelTurns))); }
  catch (e) { log("turns_save_warn", { error: e.message }); }
}
const CURSOR_MAX_TURNS_PER_CHAT = parseInt(process.env.JARVIS_MAX_TURNS || process.env.CURSOR_MAX_TURNS || "150");
const CURSOR_MAX_AGE_MS = parseInt(process.env.JARVIS_MAX_AGE_MS || process.env.CURSOR_MAX_AGE_MS || String(3 * 24 * 3600 * 1000)); // 3 days
// createdAt timestamps per channel for age-based rotation
const channelCreatedAt = new Map(Object.entries(loadJsonFile(SESSION_STORE_PATH + ".created")));
function saveCreatedAt() {
  try { fs.writeFileSync(SESSION_STORE_PATH + ".created", JSON.stringify(Object.fromEntries(channelCreatedAt))); }
  catch (e) { log("created_save_warn", { error: e.message }); }
}

// Per-channel in-flight Promise lock — prevents duplicate create-chat on concurrent requests
const channelSessionLocks = new Map();

// ── Child process tracking for clean shutdown ─────────────────────────────────
const activeChildren = new Set();

// ── Base args for all claude -p calls ────────────────────────────────────────
// --dangerously-skip-permissions: equivalent to --trust + --force in cursor-agent.
//   Auto-approves tool use and MCP connections in headless mode.
// --include-partial-messages: equivalent to --stream-partial-output.
//   Emits partial assistant events as content accumulates (used for SSE delta forwarding).
const BASE_ARGS = [
  "-p", "--verbose", "--dangerously-skip-permissions",
  "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
  "--output-format", "stream-json", "--include-partial-messages",
];

function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), svc: "jarvis-gateway", event, ...data };
  console.log(JSON.stringify(entry));
}

function requireAuth(req, res, next) {
  if (!GATEWAY_TOKEN) return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${GATEWAY_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function contentToText(content) {
  if (typeof content === "string") return content.replace(/\0/g, "");
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n").replace(/\0/g, "");
  }
  return "";
}

// Collapse messages array to a flat prompt string.
// System message is extracted and prepended as a context block so cursor-agent
// can distinguish instructions from conversation history.
function collapseMessages(messages = []) {
  const sys = messages.find((m) => m?.role === "system");
  const turns = messages.filter((m) => m?.role !== "system");
  const sysText = sys ? contentToText(sys.content) : "";
  const history = turns
    .map((msg) => {
      const role = String(msg?.role || "user").toUpperCase();
      const text = contentToText(msg?.content);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return sysText ? `${sysText}\n\n---\n\n${history}` : history;
}

// Spawn claude -p with stream-json output; optionally resume a prior session.
// Prompt is written to stdin to avoid ARG_MAX limits on large conversation histories.
function spawnClaudeStream(prompt, model, chatId, channelKey) {
  const args = [...BASE_ARGS, "--model", model];
  if (chatId) args.push("--resume", chatId);
  // Strip proxy/token overrides so claude uses its own stored OAuth credentials
  // from ~/.claude/ rather than any stale env vars set by the parent service.
  const { ANTHROPIC_BASE_URL: _a, CLAUDE_CODE_OAUTH_TOKEN: _b, ...cleanEnv } = process.env;
  const profile = resolveProfile(channelKey);
  if (profile?.configDir) cleanEnv.CLAUDE_CONFIG_DIR = profile.configDir;
  log("claude_spawn", { model, chatId: chatId || null, channelKey, profile: profile?.label || "default", configDir: profile?.configDir || null });
  const child = spawn(CLAUDE_BIN, args, {
    env: cleanEnv,
    timeout: CURSOR_AGENT_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(prompt.replace(/\0/g, ""), "utf8");
  activeChildren.add(child);
  child.on("close", () => activeChildren.delete(child));
  return child;
}

// Summarize the old chatId to haivemind before rotation so context survives.
// Fire-and-forget — does not block the rotation; new chat starts fresh immediately.
async function summarizeAndStoreChat(channelKey, oldChatId) {
  const SUMMARY_PROMPT = "In 400 words or less, summarize the key state of this conversation: decisions made, open tasks, blockers, and any important context the next session should know. Be specific and terse.";
  try {
    const result = await callClaudeAgent(SUMMARY_PROMPT, DEFAULT_CLAUDE_MODEL, oldChatId);
    if (!result.text) return;
    // Store to haivemind under channel namespace — getChannelContext() will pick this up next turn
    const channelId = (channelKey.match(/channel:(\d+)/) || [])[1];
    if (channelId && DISCORD_TOKEN) {
      await fetch(`http://127.0.0.1:${process.env.HAIVEMIND_PORT || 8900}/store_memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `[SESSION SUMMARY] ${result.text}`, category: `channel:${channelId}` }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    log("chat_summary_stored", { channelKey, channelId, chars: result.text.length });
  } catch (e) {
    log("chat_summary_failed", { channelKey, error: e.message });
  }
}

// Return an existing chatId for the channel, or create a new one.
// Uses a per-channel Promise lock to prevent duplicate create-chat on concurrent requests.
// Rotates automatically if turn count or age limits are exceeded.
async function getOrCreateChatId(channelKey) {
  if (channelKey && channelSessions.has(channelKey)) {
    const turns = channelTurns.get(channelKey) || 0;
    const age = Date.now() - (channelCreatedAt.get(channelKey) || 0);
    if (turns >= CURSOR_MAX_TURNS_PER_CHAT || age > CURSOR_MAX_AGE_MS) {
      const oldChatId = channelSessions.get(channelKey);
      log("chat_rotation", { channelKey, turns, ageMs: age, reason: turns >= CURSOR_MAX_TURNS_PER_CHAT ? "turns" : "age" });
      // Summarize old session to haivemind (fire-and-forget, does not block rotation)
      summarizeAndStoreChat(channelKey, oldChatId).catch(() => {});
      metrics.sessionsRotated++;
      channelSessions.delete(channelKey);
      channelTurns.delete(channelKey);
      channelCreatedAt.delete(channelKey);
      saveSessions(); saveTurns(); saveCreatedAt();
    } else {
      metrics.sessionsResumed++;
      return channelSessions.get(channelKey);
    }
  }
  // No existing session — return null. claude -p will create a fresh session
  // and return a session_id in the system init event; setSession() stores it.
  metrics.sessionsCreated++;
  return null;
}

function setSession(channelKey, sessionId) {
  if (!channelKey || !sessionId) return;
  const isNew = !channelSessions.has(channelKey);
  channelSessions.set(channelKey, sessionId);
  channelTurns.set(channelKey, (channelTurns.get(channelKey) || 0) + 1);
  if (isNew) { channelCreatedAt.set(channelKey, Date.now()); saveCreatedAt(); }
  saveSessions(); saveTurns();
}

// ── RSS watchdog — kills cursor-agent children that grow beyond 2.5 GB ───────
const MAX_CHILD_RSS_BYTES = parseFloat(process.env.CURSOR_MAX_RSS_GB || "2.5") * 1024 ** 3;
function getChildRss(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = stat.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1]) * 1024 : 0;
  } catch { return 0; }
}
setInterval(() => {
  for (const child of activeChildren) {
    if (!child.pid) continue;
    const rss = getChildRss(child.pid);
    if (rss > MAX_CHILD_RSS_BYTES) {
      log("rss_watchdog_kill", { pid: child.pid, rssGb: (rss / 1e9).toFixed(2), limitGb: MAX_CHILD_RSS_BYTES / 1e9 });
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}, 30_000).unref();

// Buffer the full response from claude -p (non-streaming path).
// Parses NDJSON lines; extracts text from result event and session_id from system:init.
async function callClaudeAgent(prompt, modelOverride, chatId, channelKey) {
  const model = resolveModel(modelOverride) || DEFAULT_CLAUDE_MODEL;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnClaudeStream(prompt, model, chatId, channelKey);
    let buf = "";
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => { buf += d; });
    child.on("close", (code) => {
      const durationMs = Date.now() - start;
      let resultText = "";
      let sessionId = chatId || null;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) sessionId = ev.session_id;
          if (ev.type === "result") {
            if (ev.is_error) return reject(new Error(ev.result || "claude error"));
            resultText = ev.result || "";
          }
        } catch { /* skip malformed lines */ }
      }
      if (code !== 0 && !resultText) {
        if (code === 143) metrics.timeouts++;
        else metrics.errors++;
        const msg = code === 143
          ? `claude timed out after ${CURSOR_AGENT_TIMEOUT_MS / 1000}s — task may need more time`
          : `claude exited ${code}: ${stderr.slice(0, 300)}`;
        log("claude_agent_error", { code, durationMs, model, error: msg });
        return reject(new Error(msg));
      }
      log("claude_agent_done", { code, durationMs, model, chars: resultText.length });
      resolve({ text: resultText, model: `claude/${model}`, sessionId });
    });
    child.on("error", (err) => { metrics.errors++; reject(err); });
  });
}

// Stream claude -p NDJSON deltas directly to an SSE response.
// Returns the resolvedSessionId once the stream completes.
async function streamClaudeToSSE(prompt, model, chatId, res, req, channelKey) {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnClaudeStream(prompt, model, chatId, channelKey);
    let lineBuf = "";
    let resolvedSessionId = chatId;
    let clientAborted = false;
    let lastTextLen = 0;  // tracks how many chars we've already forwarded as deltas

    // Client-disconnect handler — kill the cursor-agent child when the HTTP
    // client aborts the stream. Without this, aborted requests orphan the
    // child process until RSS watchdog or shutdown kills it.
    // Use res.on('close') rather than req.on('close') — the body-parser
    // middleware consumes the request stream, and `res.close` fires reliably
    // when the TCP connection closes on both normal end and abort.
    const onClose = () => {
      if (clientAborted) return;
      // If the response completed cleanly, res.writableEnded is true — skip.
      if (res.writableEnded) return;
      clientAborted = true;
      log("stream_client_aborted", { model, durationMs: Date.now() - start });
      metrics.clientAborts = (metrics.clientAborts || 0) + 1;
      try { child.kill("SIGTERM"); } catch {}
      // Give it 2s to exit cleanly, then SIGKILL.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000).unref();
      reject(new Error("client disconnected"));
    };
    res.once("close", onClose);

    function sendDelta(text) {
      if (clientAborted) return;
      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: `claude/${model}`,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    function handleLine(line) {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      // session_id appears on every event type in claude CLI output
      if (ev.session_id) resolvedSessionId = ev.session_id;
      // claude CLI accumulates text across assistant events; emit only the new chars each time
      if (ev.type === "assistant") {
        const text = ev.message?.content?.[0]?.text ?? "";
        if (text.length > lastTextLen) {
          sendDelta(text.slice(lastTextLen));
          lastTextLen = text.length;
        }
      }
      if (ev.type === "result" && ev.is_error) reject(new Error(ev.result || "claude stream error"));
    }

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // hold incomplete last line
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      res.removeListener("close", onClose);
      if (clientAborted) return; // already rejected with "client disconnected"
      if (lineBuf.trim()) handleLine(lineBuf);
      const durationMs = Date.now() - start;
      if (code !== 0) {
        if (code === 143) metrics.timeouts++;
        else metrics.errors++;
        const msg = code === 143
          ? `claude timed out after ${CURSOR_AGENT_TIMEOUT_MS / 1000}s — task may need more time`
          : `claude exited ${code}`;
        log("claude_agent_error", { code, durationMs, model, streaming: true, error: msg });
        return reject(new Error(msg));
      }
      log("claude_agent_done", { code, durationMs, model, streaming: true });
      resolve(resolvedSessionId);
    });
    child.on("error", (err) => {
      res.removeListener("close", onClose);
      metrics.errors++;
      reject(err);
    });
  });
}

function openAiCompletionResponse(model, text) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

function extractTaskId(message) {
  const match = message.match(/taskId":"([^"]+)"/) || message.match(/Task #(\d+)/i);
  return match ? match[1] : "";
}

function extractTargetChannelId(message) {
  const match = message.match(/channel:(\d{10,})/);
  return match ? match[1] : DEFAULT_REPORT_CHANNEL;
}

function summarize(text) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "Task completed.";
  const parts = trimmed.match(/[^.!?]+[.!?]*/g) || [trimmed];
  return parts.slice(0, 2).join(" ").slice(0, 320).trim();
}

async function postDiscordMessage(channelId, content) {
  if (!DISCORD_TOKEN || !channelId || !content) return;
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];
  for (const chunk of chunks) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord ${response.status}: ${body}`);
    }
  }
}

const HAIVEMIND_URL = process.env.HAIVEMIND_URL || `http://127.0.0.1:${process.env.HAIVEMIND_PORT || 8900}`;
const REMEMBER_RE = /^(?:jarvis[,\s]+)?(?:remember|store|save|note)\s+(?:this[:\s]+)?(.+)/i;

// Store a memory directly via haivemind HTTP — no LLM involvement.
async function storeMemory(content, category = "global") {
  const res = await fetch(`${HAIVEMIND_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "store_memory", arguments: { content, category } },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`haivemind ${res.status}`);
  const raw = await res.text();
  // haivemind responds with SSE — extract the data: line
  const dataLine = raw.split("\n").find(l => l.startsWith("data:"));
  const body = JSON.parse(dataLine ? dataLine.slice(5).trim() : raw);
  const text = body?.result?.content?.[0]?.text || body?.result?.structuredContent?.result || "{}";
  // Extract memory ID from text like "Memory stored with ID: <uuid>"
  const idMatch = text.match(/[0-9a-f-]{36}/);
  return idMatch ? { memory_id: idMatch[0] } : {};
}

async function postSpeakSummary(message, taskId) {
  if (!ALERT_WEBHOOK_TOKEN || !message) return;
  await fetch(SPEAK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALERT_WEBHOOK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, source: "task-progress", taskId }),
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), sessions: channelSessions.size, activeChildren: activeChildren.size });
});

app.get("/models", requireAuth, (_req, res) => {
  res.json({
    aliases: Object.entries(MODEL_ALIASES).map(([alias, model]) => ({ alias, model })),
    default: DEFAULT_CLAUDE_MODEL,
  });
});

app.get("/metrics", (_req, res) => {
  res.json({
    ...metrics,
    activeSessions: channelSessions.size,
    activeChildren: activeChildren.size,
    pendingLocks: channelSessionLocks.size,
    maxTurnsPerChat: CURSOR_MAX_TURNS_PER_CHAT,
    maxRssGb: MAX_CHILD_RSS_BYTES / 1e9,
    uptime: process.uptime(),
  });
});

app.post("/admin/reload-accounts", requireAuth, (_req, res) => {
  channelAccounts = loadChannelAccounts();
  const stats = validateProfiles();
  log("accounts_reloaded", stats);
  res.json({ ok: true, profiles: stats });
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  metrics.requests++;
  try {
    const requestedModel = String(req.body?.model || DEFAULT_CLAUDE_MODEL);
    const model = resolveModel(requestedModel) || DEFAULT_CLAUDE_MODEL;
    const prompt = collapseMessages(req.body?.messages || []);
    const channelKey = String(req.body?.user || "").trim() || null;
    const wantStream = Boolean(req.body?.stream);

    if (wantStream) metrics.requestsStreaming++;

    // Intercept "remember X" patterns — store directly to haivemind, skip claude.
    const lastUserMsg = (req.body?.messages || []).filter(m => m?.role === "user").pop();
    const rememberMatch = lastUserMsg && REMEMBER_RE.exec(contentToText(lastUserMsg.content));
    if (rememberMatch) {
      const content = rememberMatch[1].trim();
      try {
        const stored = await storeMemory(content);
        const memId = stored?.memory_id || stored?.id || "ok";
        const reply = `Saved. (${memId.slice(0, 8)})`;
        log("memory_stored", { channelKey, chars: content.length, memId });
        if (wantStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          const chunk = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.json(openAiCompletionResponse(requestedModel, reply));
        }
        return;
      } catch (e) {
        log("memory_store_failed", { channelKey, error: e.message });
        // fall through to claude on failure
      }
    }

    const chatId = await getOrCreateChatId(channelKey);

    if (wantStream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let resolvedSessionId;
      try {
        resolvedSessionId = await streamClaudeToSSE(prompt, model, chatId, res, req, channelKey);
      } catch (streamError) {
        // Don't try to write to a closed/aborted socket.
        if (streamError.message === "client disconnected" || res.writableEnded || req.destroyed) return;
        log("stream_error", { channelKey, model, error: streamError.message });
        res.write(`data: ${JSON.stringify({ error: streamError.message })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      setSession(channelKey, resolvedSessionId);

      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming path
    const result = await callClaudeAgent(prompt, requestedModel, chatId, channelKey);
    setSession(channelKey, result.sessionId);
    res.json(openAiCompletionResponse(requestedModel, result.text));
  } catch (error) {
    metrics.errors++;
    log("completions_error", { error: String(error.message || error) });
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/hooks/agent", requireAuth, async (req, res) => {
  metrics.hooksAgent++;
  const message = String(req.body?.message || "");
  const taskId = extractTaskId(message);
  const channelId = extractTargetChannelId(message);
  res.status(202).json({ accepted: true, taskId, backend: "jarvis-gateway" });

  queueMicrotask(async () => {
    let result;
    try {
      result = await callClaudeAgent(message);
    } catch (error) {
      const failure = `Task ${taskId || ""} failed: ${error.message || error}`.trim();
      log("hooks_agent_error", { taskId, channelId, error: String(error.message || error) });
      try {
        if (channelId) await postDiscordMessage(channelId, failure);
      } catch (discordError) {
        log("discord_post_error", { taskId, error: String(discordError.message || discordError) });
      }
      try {
        await postSpeakSummary("The task failed.", taskId);
      } catch (speakError) {
        log("speak_post_error", { taskId, error: String(speakError.message || speakError) });
      }
      return;
    }

    try {
      if (channelId) {
        await postDiscordMessage(channelId, result.text || "Task completed with no text response.");
      }
    } catch (discordError) {
      log("discord_post_error", { taskId, error: String(discordError.message || discordError) });
    }

    try {
      await postSpeakSummary(summarize(result.text), taskId);
    } catch (speakError) {
      log("speak_post_error", { taskId, error: String(speakError.message || speakError) });
    }

    log("hooks_agent_done", { taskId, channelId, model: result.model });
  });
});

app.use((_req, res) => {
  res.status(405).json({ error: "Unsupported route" });
});

// ── Graceful shutdown — drain in-flight cursor-agent children before exiting ──
// Waits up to 30 s for active children to finish, then force-kills stragglers.
// TimeoutStopSec=45s in the service unit gives this enough runway.
async function shutdown(signal) {
  log("shutdown_start", { signal, activeChildren: activeChildren.size });
  server.close();
  const deadline = Date.now() + 30_000;
  while (activeChildren.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (activeChildren.size > 0) {
    log("shutdown_drain_timeout", { remaining: activeChildren.size });
    for (const child of activeChildren) { try { child.kill("SIGKILL"); } catch {} }
  }
  log("shutdown_done", { signal });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Startup validation ────────────────────────────────────────────────────────
import { accessSync, constants as fsConstants } from "node:fs";
function validateStartup() {
  try {
    accessSync(CLAUDE_BIN, fsConstants.X_OK);
  } catch {
    log("fatal", { msg: `Claude CLI not found or not executable at ${CLAUDE_BIN}. Run: claude login` });
    process.exit(1);
  }
  if (!GATEWAY_TOKEN) {
    log("warn", { msg: "JARVIS_GATEWAY_TOKEN not set — all requests will be rejected as Unauthorized" });
  }
}
validateStartup();

const server = app.listen(PORT, "127.0.0.1", () => {
  const profileStats = validateProfiles();
  log("startup", {
    port: PORT,
    bin: CLAUDE_BIN,
    model: DEFAULT_CLAUDE_MODEL,
    sessions: channelSessions.size,
    sessionStore: SESSION_STORE_PATH,
    profiles_loaded: profileStats,
  });
});
