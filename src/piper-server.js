/**
 * Piper TTS HTTP Server — JARVIS voice (persistent warm process)
 * 
 * Keeps Piper running as a long-lived process reading from stdin.
 * Model stays loaded in memory — each sentence is ~600ms instead of ~2s.
 * 
 * POST /tts { "text": "Hello sir" } → audio/wav
 * GET /health → status
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { watch } from 'fs';
import { randomUUID } from 'crypto';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'models', 'jarvis');
const PORT = parseInt(process.env.PIPER_PORT || '3336');
const BIND = process.env.PIPER_BIND || '127.0.0.1';
const DEFAULT_MODEL = process.env.PIPER_MODEL || 'medium';
const PIPER_BIN = process.env.PIPER_BIN || `${process.env.HOME}/.local/bin/piper`;

const MODELS = {
  medium: join(MODELS_DIR, 'jarvis-medium.onnx'),
  high: join(MODELS_DIR, 'jarvis-high.onnx'),
};

let requestCount = 0;
let lastRequestTime = null;

// ── Persistent Piper process per model ───────────────────────────────
// Piper reads lines from stdin, writes WAV files to output dir.
// Model stays warm in memory — subsequent sentences are ~600ms.

const OUTPUT_DIR = '/tmp/piper-output';
const piperProcesses = {}; // model -> { proc, queue }

async function ensureOutputDir() {
  try { await mkdir(OUTPUT_DIR, { recursive: true }); } catch {}
}

function getPiperProcess(model = DEFAULT_MODEL) {
  if (piperProcesses[model] && !piperProcesses[model].dead) {
    return piperProcesses[model];
  }
  
  const modelPath = MODELS[model] || MODELS[DEFAULT_MODEL];
  logger.info(`🔧 Starting persistent Piper process (${model})...`);
  
  const proc = spawn(PIPER_BIN, [
    '--model', modelPath,
    '-d', OUTPUT_DIR,
    '--output-dir-naming', 'timestamp',
    '--length-scale', '0.95',  // 5% faster, matches model config
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  
  const state = {
    proc,
    dead: false,
    queue: [],      // pending requests: { resolve, reject, startTime }
    processing: false,
  };
  
  // Watch for output files
  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    // Piper logs "Wrote /path/to/file.wav" on stderr
    const match = msg.match(/Wrote (.+\.wav)/);
    if (match && state.queue.length > 0) {
      const filePath = match[1].trim();
      const pending = state.queue.shift();
      const elapsed = Date.now() - pending.startTime;
      
      // Read the file and resolve
      readFile(filePath)
        .then(audio => {
          unlink(filePath).catch(() => {});
          pending.resolve({ audio, elapsed });
          state.processing = false;
          processNextInQueue(model);
        })
        .catch(err => {
          pending.reject(err);
          state.processing = false;
          processNextInQueue(model);
        });
    }
  });
  
  proc.on('close', (code) => {
    logger.info(`⚠️ Piper process (${model}) exited with code ${code}`);
    state.dead = true;
    // Reject all pending
    for (const pending of state.queue) {
      pending.reject(new Error(`Piper process died (code ${code})`));
    }
    state.queue = [];
    delete piperProcesses[model];
  });
  
  proc.on('error', (err) => {
    logger.error(`❌ Piper process error: ${err.message}`);
    state.dead = true;
  });
  
  piperProcesses[model] = state;
  return state;
}

function processNextInQueue(model) {
  const state = piperProcesses[model];
  if (!state || state.dead || state.processing || state.queue.length === 0) return;
  
  state.processing = true;
  const pending = state.queue[0]; // Don't shift yet — shift when output arrives
  
  // Write text to stdin — Piper processes one line at a time
  state.proc.stdin.write(pending.text + '\n');
}

function generateSpeech(text, model = DEFAULT_MODEL) {
  return new Promise((resolve, reject) => {
    const state = getPiperProcess(model);
    
    state.queue.push({
      text,
      resolve,
      reject,
      startTime: Date.now(),
    });
    
    // If not currently processing, start
    if (!state.processing) {
      processNextInQueue(model);
    }
  });
}

// ── HTTP Server ──────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const models = {};
    for (const [name, state] of Object.entries(piperProcesses)) {
      models[name] = { alive: !state.dead, queueLength: state.queue.length };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'piper-tts-jarvis',
      mode: 'persistent',
      defaultModel: DEFAULT_MODEL,
      models,
      requests: requestCount,
      lastRequest: lastRequestTime,
    }));
    return;
  }
  
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text, model } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text required' }));
          return;
        }
        
        // Clean text for Piper — single line, no newlines
        const cleanText = text.replace(/\n/g, ' ').trim();
        
        requestCount++;
        lastRequestTime = new Date().toISOString();
        
        const { audio, elapsed } = await generateSpeech(cleanText, model || DEFAULT_MODEL);
        
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'X-Piper-Model': model || DEFAULT_MODEL,
          'X-Piper-Latency-Ms': String(elapsed),
        });
        res.end(audio);
      } catch (err) {
        logger.error('TTS error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

await ensureOutputDir();

// Pre-warm the default model
getPiperProcess(DEFAULT_MODEL);

server.listen(PORT, BIND, () => {
  logger.info(`🗣️  Piper TTS (JARVIS) listening on ${BIND}:${PORT}`);
  logger.info(`   Mode: persistent (model stays warm in memory)`);
  logger.info(`   Default model: ${DEFAULT_MODEL}`);
  logger.info(`   Endpoint: POST /tts { "text": "...", "model": "medium|high" }`);
});
