#!/usr/bin/env node
/**
 * Test script for agent completion polling
 * 
 * Usage:
 *   node test-polling.js
 * 
 * This tests the polling logic without requiring a full voice bot instance
 */

import 'dotenv/config';
import { pollAgentCompletion, extractTLDR } from './src/agent-delegate.js';

// Test TL;DR extraction
console.log('🧪 Testing TL;DR extraction...\n');

const testCases = [
  {
    input: 'You have 3 unread emails. The most important is from your boss about the quarterly review. One is a newsletter from Medium. I archived 5 old promotional emails as requested.',
    expected: '~First 2-3 sentences, max 150 chars'
  },
  {
    input: 'Calendar check complete. You have a meeting at 2 PM today with the design team. Tomorrow you have a dentist appointment at 10 AM.',
    expected: '~First 2-3 sentences'
  },
  {
    input: 'Task completed successfully.',
    expected: 'Task completed successfully.'
  },
  {
    input: '',
    expected: 'Agent completed.'
  }
];

testCases.forEach((testCase, i) => {
  const result = extractTLDR(testCase.input);
  console.log(`Test ${i + 1}:`);
  console.log(`  Input:    "${testCase.input}"`);
  console.log(`  TL;DR:    "${result}"`);
  console.log(`  Length:   ${result.length} chars`);
  console.log(`  Expected: ${testCase.expected}`);
  console.log();
});

// Test polling (will timeout since no real agent)
console.log('🧪 Testing polling logic (will timeout in 10s)...\n');

const mockSessionKey = 'hook:jarvis-voice:task:test123';
const startTime = Date.now();

pollAgentCompletion(mockSessionKey, 10000)
  .then(result => {
    const elapsed = Date.now() - startTime;
    console.log(`\n✅ Polling test completed in ${elapsed}ms`);
    console.log(`   Result: ${JSON.stringify(result, null, 2)}`);
    
    if (!result.completed) {
      console.log('   ✅ Timeout behavior working correctly');
    }
  })
  .catch(err => {
    console.error('❌ Polling test failed:', err.message);
  });
