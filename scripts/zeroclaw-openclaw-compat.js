import express from "express";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.ZEROCLAW_COMPAT_PORT || 22103);
const ZEROCLAW_BASE_URL = process.env.ZEROCLAW_BASE_URL || "http://127.0.0.1:22101";
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || "";
const CURSOR_AGENT_BIN = process.env.CURSOR_AGENT_BIN || `${process.env.HOME}/.local/bin/cursor-agent`;
const CURSOR_API_KEY = process.env.CURSOR_API_KEY || "";
// Strip cursor-agent/ prefix if present; default to claude-4.6-sonnet-medium
// Known real model prefixes cursor-agent accepts; anything else (e.g. "openclaw") is a placeholder
const CURSOR_MODEL_RE = /^(claude-|gpt-|gemini-|o[0-9]|auto$|composer|anthropic)/;
function resolveModel(raw) {
  if (!raw) return "";
  const m = String(raw);
  if (m.startsWith("cursor-agent/")) return m.slice("cursor-agent/".length);
  if (CURSOR_MODEL_RE.test(m)) return m;
  return ""; // placeholder like "openclaw" - fall through to default
}
const DEFAULT_CURSOR_MODEL = resolveModel(process.env.CURSOR_AGENT_MODEL) || resolveModel(process.env.DISPATCH_MODEL) || "claude-4.6-sonnet-medium";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DEFAULT_REPORT_CHANNEL = process.env.DISCORD_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID || "";
const ALERT_WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || "";
const ALERT_WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || "3335";
const ALERT_WEBHOOK_HOST = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || "127.0.0.1";
const SPEAK_URL = process.env.ZEROCLAW_COMPAT_SPEAK_URL || `http://${ALERT_WEBHOOK_HOST}:${ALERT_WEBHOOK_PORT}/speak`;

function log(...args) {
  console.log("[zeroclaw-openclaw-compat]", ...args);
}

function requireAuth(req, res, next) {
  if (!GATEWAY_TOKEN) return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${GATEWAY_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function collapseMessages(messages = []) {
  return messages
    .map((msg) => {
      const role = String(msg?.role || "user").toUpperCase();
      const text = contentToText(msg?.content);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function callCursorAgent(prompt, modelOverride) {
  const model = resolveModel(modelOverride) || DEFAULT_CURSOR_MODEL;
  return new Promise((resolve, reject) => {
    const args = ["--print", "--trust", "--output-format", "text", "--model", model];
    const child = spawn(CURSOR_AGENT_BIN, [...args, prompt], {
      env: { ...process.env, CURSOR_API_KEY },
      timeout: 180_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cursor-agent exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve({ text: stdout.trim(), model: `cursor-agent/${model}` });
      }
    });
    child.on("error", reject);
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

function sseChunksFromText(text) {
  const chunks = text.match(/[^.!?\n]+[.!?\n]*|.+$/g) || [text];
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
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

async function postSpeakSummary(message, taskId) {
  if (!ALERT_WEBHOOK_TOKEN || !message) return;
  await fetch(SPEAK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALERT_WEBHOOK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      source: "task-progress",
      taskId,
    }),
  });
}

app.get("/health", async (_req, res) => {
  try {
    const response = await fetch(`${ZEROCLAW_BASE_URL}/health`);
    const body = await response.text();
    res.status(response.status).type("application/json").send(body);
  } catch (error) {
    res.status(502).json({ status: "error", error: String(error.message || error) });
  }
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  try {
    const requestedModel = String(req.body?.model || "openclaw");
    const prompt = collapseMessages(req.body?.messages || []);
    const result = await callCursorAgent(prompt, requestedModel);

    if (req.body?.stream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const chunks = sseChunksFromText(result.text);
      for (const chunk of chunks) {
        const payload = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.json(openAiCompletionResponse(requestedModel, result.text));
  } catch (error) {
    log("chat completion failed", error.message || error);
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/hooks/agent", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "");
  const taskId = extractTaskId(message);
  const channelId = extractTargetChannelId(message);
  res.status(202).json({ accepted: true, taskId, backend: "zeroclaw-openclaw-compat" });

  queueMicrotask(async () => {
    let result;
    try {
      result = await callCursorAgent(message);
    } catch (error) {
      const failure = `Task ${taskId || ""} failed: ${error.message || error}`.trim();
      log("async task cursor-agent call failed", failure);
      try {
        if (channelId) await postDiscordMessage(channelId, failure);
      } catch (discordError) {
        log("async task discord failure post failed", discordError.message || discordError);
      }
      try {
        await postSpeakSummary("The cursor-agent task failed.", taskId);
      } catch (speakError) {
        log("async task speak failure post failed", speakError.message || speakError);
      }
      return;
    }

    try {
      if (channelId) {
        await postDiscordMessage(channelId, result.text || "Task completed with no text response.");
      }
    } catch (discordError) {
      log("async task discord delivery failed", discordError.message || discordError);
    }

    try {
      await postSpeakSummary(summarize(result.text), taskId);
    } catch (speakError) {
      log("async task speak delivery failed", speakError.message || speakError);
    }

    log("async task delivered", { taskId, channelId, model: result.model });
  });
});

app.use((_req, res) => {
  res.status(405).json({ error: "Unsupported route" });
});

app.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}`, `-> cursor-agent (${CURSOR_AGENT_BIN}) model=${DEFAULT_CURSOR_MODEL}`);
});
