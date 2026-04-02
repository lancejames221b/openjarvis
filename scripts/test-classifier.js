#!/usr/bin/env node
/**
 * Test the intent classifier with various inputs
 */

import { classifyIntent } from './src/intent-classifier.js';

const testCases = [
  // CHAT
  { transcript: 'Hey Jarvis', speechDurationMs: 1000, expected: 'CHAT' },
  { transcript: 'Thanks', speechDurationMs: 800, expected: 'CHAT' },
  
  // ACTION
  { transcript: 'Clean my inbox', speechDurationMs: 2000, expected: 'ACTION' },
  { transcript: 'Send a message to the security channel', speechDurationMs: 3500, expected: 'ACTION' },
  { transcript: 'Archive all read emails', speechDurationMs: 2500, expected: 'ACTION' },
  
  // QUERY
  { transcript: 'What emails do I have', speechDurationMs: 2000, expected: 'QUERY' },
  { transcript: 'Is there anything urgent', speechDurationMs: 2500, expected: 'QUERY' },
  { transcript: 'How many meetings today', speechDurationMs: 2000, expected: 'QUERY' },
  
  // LIST_QUERY
  { transcript: 'Show me my emails', speechDurationMs: 2000, expected: 'LIST_QUERY' },
  { transcript: "What's on my calendar", speechDurationMs: 2500, expected: 'LIST_QUERY' },
  { transcript: 'List all the threads', speechDurationMs: 2000, expected: 'LIST_QUERY' },
  
  // DEEP_DIVE
  { transcript: 'Explain how the kubernetes cluster works', speechDurationMs: 4000, expected: 'DEEP_DIVE' },
  { transcript: 'Walk me through the threat analysis', speechDurationMs: 3500, expected: 'DEEP_DIVE' },
  { transcript: 'Analyze the malware sample', speechDurationMs: 2500, expected: 'DEEP_DIVE' },
  
  // FOLLOW_UP
  { transcript: 'Yes', speechDurationMs: 500, isFollowUp: true, expected: 'FOLLOW_UP' },
  { transcript: 'The first one', speechDurationMs: 1000, isFollowUp: true, expected: 'FOLLOW_UP' },
  { transcript: 'Tell me more', speechDurationMs: 1500, isFollowUp: true, expected: 'FOLLOW_UP' },
  
  // Duration-based adjustments
  { transcript: 'Quick question about the file', speechDurationMs: 1500, expected: 'QUERY' },
  { transcript: 'I need a very detailed breakdown of everything that happened with the security incident including all the steps you took and the reasoning behind each decision', speechDurationMs: 18000, expected: 'DEEP_DIVE' }, // "detailed breakdown" -> DEEP_DIVE is correct
];

console.log('🧪 Testing Intent Classifier\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = classifyIntent({
    transcript: testCase.transcript,
    speechDurationMs: testCase.speechDurationMs || 0,
    conversationDepth: testCase.conversationDepth || 0,
    isFollowUp: testCase.isFollowUp || false,
    previousResponseType: testCase.previousResponseType || null,
  });
  
  const success = result.type === testCase.expected;
  const icon = success ? '✅' : '❌';
  
  if (success) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${icon} "${testCase.transcript.substring(0, 50)}${testCase.transcript.length > 50 ? '...' : ''}"`);
  console.log(`   Expected: ${testCase.expected}, Got: ${result.type}`);
  console.log(`   Budget: ${result.maxSentences} sentences, ${result.maxSpokenSeconds}s, ${result.responseStyle}`);
  console.log(`   Instruction: ${result.budgetInstruction.substring(0, 80)}...`);
  console.log('');
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests`);

if (failed > 0) {
  process.exit(1);
}
