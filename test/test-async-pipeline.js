/**
 * Async Concurrent Voice Pipeline Tests
 * 
 * Tests the core async architecture WITHOUT Discord, STT, or TTS.
 * Mocks all I/O to validate task lifecycle, concurrency, cancellation,
 * response ordering, and error handling.
 * 
 * Run: node test/test-async-pipeline.js
 */

import { strict as assert } from 'assert';

// ── Mock Setup ───────────────────────────────────────────────────────

// Simulated delay (ms)
const FAST_RESPONSE = 50;
const SLOW_RESPONSE = 500;
const VERY_SLOW_RESPONSE = 2000;

// Track what happened
const log = [];
const ttsPlayed = [];
const textChannelPosts = [];

function resetState() {
  log.length = 0;
  ttsPlayed.length = 0;
  textChannelPosts.length = 0;
  activeTasks.clear();
  responseQueue.length = 0;
  conversations.clear();
  isSpeakingResponse = false;
  userDisconnected = false;
  taskIdCounter = 0;
}

// ── Replicate core logic from index.js (testable version) ────────────

const activeTasks = new Map();
let taskIdCounter = 0;
const responseQueue = [];
let isSpeakingResponse = false;
const conversations = new Map();
let userDisconnected = false;

// Interrupt patterns (same as production)
const INTERRUPT_PATTERNS = [
  /^(jarvis\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
];

function isInterruptCommand(transcript) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  return INTERRUPT_PATTERNS.some(p => p.test(clean));
}

// Mock brain — returns after configurable delay, respects abort signal
async function mockGenerateResponse(message, history, signal, delayMs = FAST_RESPONSE) {
  // Check if already aborted before starting
  if (signal && signal.aborted) {
    return { text: '', aborted: true };
  }
  
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ text: `Response to: ${message}` });
    }, delayMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ text: '', aborted: true });
      }, { once: true });
    }
  });
}

// Mock TTS — records what was "spoken"
async function mockSynthesizeSpeech(text) {
  ttsPlayed.push(text);
  return 'mock-audio-path';
}

// Mock text channel post
async function mockPostToTextChannel(message) {
  textChannelPosts.push(message);
}

// ── Core Functions (extracted from index.js for testing) ─────────────

function cancelAllTasks() {
  const count = activeTasks.size;
  for (const [taskId, task] of activeTasks) {
    task.controller.abort();
    log.push(`cancelled:${taskId}`);
  }
  activeTasks.clear();
  responseQueue.length = 0;
  isSpeakingResponse = false;
  return count;
}

async function processBrainTask(taskId, userId, transcript, history, signal, delayMs) {
  try {
    log.push(`thinking:${taskId}`);
    const result = await mockGenerateResponse(transcript, history, signal, delayMs);

    if (result.aborted) {
      log.push(`aborted:${taskId}`);
      activeTasks.delete(taskId);
      return;
    }

    const response = result.text;
    log.push(`done:${taskId}`);

    // Update conversation history
    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: response });
      while (conv.history.length > 40) conv.history.shift();
    }

    activeTasks.delete(taskId);

    if (userDisconnected) {
      await mockPostToTextChannel(`Voice handoff: ${response}`);
      return;
    }

    if (response) {
      responseQueue.push({ taskId, userId, response, startTime: Date.now() });
      await drainResponseQueue();
    }

  } catch (err) {
    activeTasks.delete(taskId);
    if (err.name !== 'AbortError') {
      log.push(`error:${taskId}:${err.message}`);
    }
  }
}

async function drainResponseQueue() {
  if (isSpeakingResponse || responseQueue.length === 0) return;
  isSpeakingResponse = true;

  while (responseQueue.length > 0) {
    const { taskId, response } = responseQueue.shift();

    if (userDisconnected) {
      await mockPostToTextChannel(`Voice handoff: ${response}`);
      continue;
    }

    await mockSynthesizeSpeech(response);
    log.push(`spoken:${taskId}`);
  }

  isSpeakingResponse = false;
}

async function dispatchTask(userId, transcript, delayMs = FAST_RESPONSE) {
  if (!conversations.has(userId)) {
    conversations.set(userId, { history: [] });
  }
  const conv = conversations.get(userId);
  conv.history.push({ role: 'user', content: transcript });

  const taskId = ++taskIdCounter;
  const controller = new AbortController();
  activeTasks.set(taskId, { controller, transcript, startTime: Date.now(), userId });
  log.push(`dispatched:${taskId}:${transcript}`);

  // Fire and forget
  const promise = processBrainTask(taskId, userId, transcript, [...conv.history], controller.signal, delayMs);
  return { taskId, promise };
}

// ── Tests ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  resetState();
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('\n🧪 Async Concurrent Voice Pipeline Tests\n');

// ── 1. Basic single task ─────────────────────────────────────────────

await test('Single task dispatches, completes, and speaks', async () => {
  const { promise } = await dispatchTask('user1', 'What is the weather?');
  await promise;

  assert.equal(activeTasks.size, 0, 'No active tasks after completion');
  assert.equal(ttsPlayed.length, 1, 'One TTS played');
  assert.ok(ttsPlayed[0].includes('What is the weather'), 'TTS contains response');
  assert.ok(log.includes('dispatched:1:What is the weather?'));
  assert.ok(log.includes('thinking:1'));
  assert.ok(log.includes('done:1'));
  assert.ok(log.includes('spoken:1'));
});

// ── 2. Multiple concurrent tasks ─────────────────────────────────────

await test('Multiple tasks run concurrently', async () => {
  const t1 = await dispatchTask('user1', 'Check email', 200);
  const t2 = await dispatchTask('user1', 'Weather report', 100);
  const t3 = await dispatchTask('user1', 'Check Linear', 150);

  assert.equal(activeTasks.size, 3, 'All 3 tasks active');

  await Promise.all([t1.promise, t2.promise, t3.promise]);

  assert.equal(activeTasks.size, 0, 'No active tasks after all complete');
  assert.equal(ttsPlayed.length, 3, 'All 3 responses spoken');
});

// ── 3. Fast task completes before slow task ──────────────────────────

await test('Fast task response plays before slow task finishes', async () => {
  const slow = await dispatchTask('user1', 'Summarize emails', SLOW_RESPONSE);
  const fast = await dispatchTask('user1', 'What time is it', FAST_RESPONSE);

  // Wait for fast to complete first
  await fast.promise;
  assert.equal(ttsPlayed.length, 1, 'Fast response spoken while slow still runs');
  assert.equal(activeTasks.size, 1, 'Slow task still active');
  assert.ok(ttsPlayed[0].includes('What time is it'));

  // Wait for slow
  await slow.promise;
  assert.equal(ttsPlayed.length, 2, 'Both responses spoken');
  assert.equal(activeTasks.size, 0, 'All tasks done');
});

// ── 4. Cancel ALL tasks ──────────────────────────────────────────────

await test('Stop command cancels all active tasks', async () => {
  const t1 = await dispatchTask('user1', 'Long task 1', VERY_SLOW_RESPONSE);
  const t2 = await dispatchTask('user1', 'Long task 2', VERY_SLOW_RESPONSE);
  const t3 = await dispatchTask('user1', 'Long task 3', VERY_SLOW_RESPONSE);

  assert.equal(activeTasks.size, 3, '3 tasks active');

  const cancelled = cancelAllTasks();
  assert.equal(cancelled, 3, 'Cancelled 3 tasks');
  assert.equal(activeTasks.size, 0, 'No active tasks');
  assert.equal(responseQueue.length, 0, 'Response queue cleared');

  // Wait for abort handlers to fire
  await Promise.all([t1.promise, t2.promise, t3.promise]);
  
  assert.equal(ttsPlayed.length, 0, 'No TTS played after cancel');
  assert.ok(log.some(l => l.startsWith('aborted:')), 'Tasks logged as aborted');
});

// ── 5. Interrupt command detection ───────────────────────────────────

await test('Interrupt patterns detected correctly', async () => {
  // Should detect
  assert.ok(isInterruptCommand('stop'), '"stop" detected');
  assert.ok(isInterruptCommand('Stop.'), '"Stop." detected');
  assert.ok(isInterruptCommand('cancel'), '"cancel" detected');
  assert.ok(isInterruptCommand('Jarvis, stop'), '"Jarvis, stop" detected');
  assert.ok(isInterruptCommand('jarvis stop'), '"jarvis stop" detected');
  assert.ok(isInterruptCommand('stop talking'), '"stop talking" detected');
  assert.ok(isInterruptCommand('cancel that'), '"cancel that" detected');
  assert.ok(isInterruptCommand('shut up'), '"shut up" detected');
  assert.ok(isInterruptCommand('enough'), '"enough" detected');
  assert.ok(isInterruptCommand('nevermind'), '"nevermind" detected');
  assert.ok(isInterruptCommand("that's enough"), '"that\'s enough" detected');
  assert.ok(isInterruptCommand('hold on'), '"hold on" detected');
  assert.ok(isInterruptCommand('wait'), '"wait" detected');

  // Should NOT detect
  assert.ok(!isInterruptCommand('stop the world I want to get off'), 'Long sentence not detected');
  assert.ok(!isInterruptCommand("don't stop"), '"don\'t stop" not detected');
  assert.ok(!isInterruptCommand('Can you stop by the store?'), 'Casual "stop" in sentence not detected');
  assert.ok(!isInterruptCommand('What is a bus stop?'), '"bus stop" not detected');
  assert.ok(!isInterruptCommand('check email'), 'Normal command not detected');
});

// ── 6. Conversation history maintained ───────────────────────────────

await test('Conversation history updated correctly across tasks', async () => {
  const t1 = await dispatchTask('user1', 'First question');
  await t1.promise;

  const conv = conversations.get('user1');
  assert.equal(conv.history.length, 2, 'History has user + assistant');
  assert.equal(conv.history[0].role, 'user');
  assert.equal(conv.history[1].role, 'assistant');

  const t2 = await dispatchTask('user1', 'Second question');
  await t2.promise;

  assert.equal(conv.history.length, 4, 'History has 4 entries');
});

// ── 7. History cap at 40 ─────────────────────────────────────────────

await test('Conversation history capped at 40 entries', async () => {
  for (let i = 0; i < 25; i++) {
    const t = await dispatchTask('user1', `Question ${i}`);
    await t.promise;
  }

  const conv = conversations.get('user1');
  assert.ok(conv.history.length <= 40, `History capped at 40 (got ${conv.history.length})`);
});

// ── 8. User disconnect → text channel handoff ────────────────────────

await test('User disconnect routes response to text channel', async () => {
  const t1 = await dispatchTask('user1', 'Check something', SLOW_RESPONSE);

  // User disconnects mid-processing
  userDisconnected = true;
  await t1.promise;

  assert.equal(ttsPlayed.length, 0, 'No TTS played');
  assert.equal(textChannelPosts.length, 1, 'Posted to text channel');
  assert.ok(textChannelPosts[0].includes('Voice handoff'));
});

// ── 9. Cancel with no active tasks ───────────────────────────────────

await test('Cancel with no active tasks does not crash', async () => {
  assert.equal(activeTasks.size, 0);
  const cancelled = cancelAllTasks();
  assert.equal(cancelled, 0, 'Nothing to cancel');
});

// ── 10. Rapid-fire dispatch ──────────────────────────────────────────

await test('5 rapid-fire commands all dispatch and complete', async () => {
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(await dispatchTask('user1', `Command ${i}`, 50 + i * 20));
  }

  assert.equal(activeTasks.size, 5, 'All 5 tasks active');

  await Promise.all(tasks.map(t => t.promise));

  assert.equal(activeTasks.size, 0, 'All tasks completed');
  assert.equal(ttsPlayed.length, 5, 'All 5 responses spoken');
  
  // Verify all dispatched
  for (let i = 0; i < 5; i++) {
    assert.ok(log.some(l => l.includes(`Command ${i}`)), `Command ${i} dispatched`);
  }
});

// ── 11. Cancel mid-flight preserves completed results ────────────────

await test('Cancel preserves already-spoken responses', async () => {
  const fast = await dispatchTask('user1', 'Quick one', FAST_RESPONSE);
  const slow = await dispatchTask('user1', 'Slow one', VERY_SLOW_RESPONSE);

  // Wait for fast to complete and speak
  await fast.promise;
  assert.equal(ttsPlayed.length, 1, 'Fast response already spoken');

  // Now cancel (only slow should be affected)
  cancelAllTasks();
  await slow.promise;

  assert.equal(ttsPlayed.length, 1, 'Still only 1 TTS (slow was cancelled)');
});

// ── 12. Error in one task doesn't crash others ───────────────────────

await test('Error in one task does not crash others', async () => {
  // Override one task to throw
  const t1 = await dispatchTask('user1', 'Good task', FAST_RESPONSE);
  
  // Manually create a failing task
  const taskId = ++taskIdCounter;
  const controller = new AbortController();
  activeTasks.set(taskId, { controller, transcript: 'Bad task', startTime: Date.now(), userId: 'user1' });
  log.push(`dispatched:${taskId}:Bad task`);
  
  const failPromise = (async () => {
    try {
      log.push(`thinking:${taskId}`);
      throw new Error('Simulated failure');
    } catch (err) {
      activeTasks.delete(taskId);
      log.push(`error:${taskId}:${err.message}`);
    }
  })();

  await Promise.all([t1.promise, failPromise]);

  assert.equal(activeTasks.size, 0, 'All tasks cleaned up');
  assert.equal(ttsPlayed.length, 1, 'Good task still spoke');
  assert.ok(log.some(l => l.includes('error:') && l.includes('Simulated failure')), 'Error logged');
});

// ── 13. Disconnect during drain → handoff remaining ──────────────────

await test('Disconnect during response queue drains to text', async () => {
  // Queue multiple responses manually
  responseQueue.push({ taskId: 1, userId: 'user1', response: 'First response', startTime: Date.now() });
  responseQueue.push({ taskId: 2, userId: 'user1', response: 'Second response', startTime: Date.now() });

  // Disconnect before drain starts
  userDisconnected = true;
  await drainResponseQueue();

  assert.equal(ttsPlayed.length, 0, 'No TTS played');
  assert.equal(textChannelPosts.length, 2, 'Both posted to text channel');
});

// ── 14. Task IDs are unique and incrementing ─────────────────────────

await test('Task IDs are unique and incrementing', async () => {
  const t1 = await dispatchTask('user1', 'A');
  const t2 = await dispatchTask('user1', 'B');
  const t3 = await dispatchTask('user1', 'C');

  assert.equal(t1.taskId, 1);
  assert.equal(t2.taskId, 2);
  assert.equal(t3.taskId, 3);

  await Promise.all([t1.promise, t2.promise, t3.promise]);
});

// ── 15. Abort signal already aborted before dispatch ─────────────────

await test('Pre-aborted signal returns immediately', async () => {
  const controller = new AbortController();
  controller.abort(); // Already aborted

  const result = await mockGenerateResponse('test', [], controller.signal, VERY_SLOW_RESPONSE);
  assert.ok(result.aborted, 'Immediately returns aborted');
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}: ${f.error}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
