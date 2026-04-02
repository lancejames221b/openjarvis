#!/usr/bin/env node
/**
 * Test script for voice email summary feature
 * 
 * Tests:
 * 1. SUMMARIZE intent detection
 * 2. Delegation logic (should NOT delegate)
 * 3. EMAIL_DETAIL follow-up detection
 */

import { classifyIntent } from './src/intent-classifier.js';
import { shouldDelegate } from './src/agent-delegate.js';

console.log('🧪 Voice Email Summary Feature Test\n');

// Test cases
const tests = [
  {
    name: 'Test 1: Basic summary request',
    transcript: 'Summarize my emails',
    expectedIntent: 'SUMMARIZE',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 0, isFollowUp: false, previousResponseType: null },
  },
  {
    name: 'Test 2: Inbox query',
    transcript: "What's in my inbox",
    expectedIntent: 'SUMMARIZE',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 0, isFollowUp: false, previousResponseType: null },
  },
  {
    name: 'Test 3: Check my email',
    transcript: 'Check my email',
    expectedIntent: 'SUMMARIZE',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 0, isFollowUp: false, previousResponseType: null },
  },
  {
    name: 'Test 4: Quick rundown',
    transcript: 'Give me a quick rundown of my inbox',
    expectedIntent: 'SUMMARIZE',
    shouldDelegate: false,
    signals: { speechDurationMs: 3000, conversationDepth: 0, isFollowUp: false, previousResponseType: null },
  },
  {
    name: 'Test 5: Follow-up - numbered reference',
    transcript: 'Read the third email',
    expectedIntent: 'EMAIL_DETAIL',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 1, isFollowUp: true, previousResponseType: 'SUMMARIZE' },
  },
  {
    name: 'Test 6: Follow-up - topic reference',
    transcript: 'Tell me more about the legal one',
    expectedIntent: 'EMAIL_DETAIL',
    shouldDelegate: false,
    signals: { speechDurationMs: 2500, conversationDepth: 1, isFollowUp: true, previousResponseType: 'SUMMARIZE' },
  },
  {
    name: 'Test 7: Follow-up - ordinal reference',
    transcript: 'More about the first one',
    expectedIntent: 'EMAIL_DETAIL',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 1, isFollowUp: true, previousResponseType: 'SUMMARIZE' },
  },
  {
    name: 'Test 8: Follow-up - details request',
    transcript: 'What about the urgent one',
    expectedIntent: 'EMAIL_DETAIL',
    shouldDelegate: false,
    signals: { speechDurationMs: 2000, conversationDepth: 1, isFollowUp: true, previousResponseType: 'SUMMARIZE' },
  },
  {
    name: 'Test 9: Generic yes after summary (should be FOLLOW_UP, not EMAIL_DETAIL)',
    transcript: 'Yes',
    expectedIntent: 'FOLLOW_UP',
    shouldDelegate: false,
    signals: { speechDurationMs: 500, conversationDepth: 1, isFollowUp: true, previousResponseType: 'SUMMARIZE' },
  },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  const { name, transcript, expectedIntent, shouldDelegate: expectedDelegate, signals } = test;
  
  console.log(`\n📋 ${name}`);
  console.log(`   Input: "${transcript}"`);
  
  // Test intent classification
  const classification = classifyIntent({ transcript, ...signals });
  const intentMatch = classification.type === expectedIntent;
  
  console.log(`   Intent: ${classification.type} ${intentMatch ? '✅' : `❌ (expected ${expectedIntent})`}`);
  console.log(`   Budget: ${classification.maxSentences} sentences / ${classification.maxSpokenSeconds}s`);
  
  // Test delegation
  const delegateResult = shouldDelegate(transcript, classification.type);
  const delegateMatch = delegateResult === expectedDelegate;
  
  console.log(`   Delegate: ${delegateResult} ${delegateMatch ? '✅' : `❌ (expected ${expectedDelegate})`}`);
  
  if (intentMatch && delegateMatch) {
    passed++;
  } else {
    failed++;
  }
  
  // Show budget instruction for SUMMARIZE and EMAIL_DETAIL
  if (classification.type === 'SUMMARIZE' || classification.type === 'EMAIL_DETAIL') {
    console.log(`   Instructions (preview): ${classification.budgetInstruction.substring(0, 150)}...`);
  }
}

console.log(`\n\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('✅ All tests passed!\n');
  process.exit(0);
} else {
  console.log('❌ Some tests failed\n');
  process.exit(1);
}
