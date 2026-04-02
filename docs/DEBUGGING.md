# Debugging Response Intelligence

## Quick Diagnosis

When the bot's responses aren't adapting correctly, check these signals:

### 1. Check Classification Logs

The console will show classification for each request:
```
🎯 Intent: ACTION, Budget: 3 sentences / 15s, Style: brief-confirm
```

Look for:
- Is the intent type correct?
- Is the budget reasonable?
- Are spillover hints shown when expected?

### 2. Check Conversation Tracking

```
📊 Conversation depth: 2, Last response type: QUERY
```

Verify:
- Depth increments each turn
- Depth resets when wake word is missed (conversation window expired)
- Follow-up intents only trigger when `isFollowUp: true`

### 3. Check Speech Duration

```
🔇 userId stopped speaking (2847ms of audio)
```

Duration affects classification:
- < 3000ms → Tightened budget
- > 15000ms → Extended budget allowed

### 4. Test the Classifier Directly

```bash
cd ./jarvis-voice
node test-classifier.js
```

Should show 19/19 tests passing.

## Common Issues

### Issue: Bot still too verbose on actions

**Symptom:** "Clean my inbox" triggers long narration

**Check:**
1. Is it being classified as ACTION? (check logs)
2. Is the budget instruction making it into the voice prefix?
3. Is the brain respecting the budget instruction?

**Debug:**
```javascript
// In brain.js, add logging after building voicePrefix:
console.log('📋 Voice Prefix:', voicePrefix);
```

Look for the budget instruction in the prefix. If it's there but ignored, the brain might need stronger wording.

### Issue: Follow-ups not matching context

**Symptom:** "Yes" after a LIST_QUERY gives wrong detail level

**Check:**
1. Is `lastResponseType` being stored? (check conversation tracking logs)
2. Is `isFollowUp` true? (check classification logs)
3. Is depth > 0?

**Debug:**
```javascript
// In index.js, add logging before generateResponse:
console.log('🔍 Classification signals:', classificationSignals);
```

### Issue: Conversation depth not resetting

**Symptom:** Bot thinks you're in a conversation when you're not

**Check:**
1. Wake word detection logs: should see "No wake word, skipping processing"
2. Should see "Conversation window expired, resetting depth"

**Debug:**
Check the wake word detection in `wakeword.js` — the conversation window might be too long.

### Issue: Duration-based adjustments not working

**Symptom:** Quick commands get long responses, or vice versa

**Check:**
1. Is `speechDurationMs` being calculated correctly?
2. Check the audio buffer length calculation

**Debug:**
```javascript
// In index.js, add logging:
console.log(`🎤 Speech duration: ${speechDurationMs}ms (${durationMs}ms from buffer)`);
```

Should match the audio you spoke. If wildly off, check buffer calculation.

## Testing Specific Intents

### Test ACTION Intent
Say: "Clean my inbox" or "Send a message to security"
Expect: 3 sentences, 15s budget, spillover enabled

### Test QUERY Intent
Say: "What emails do I have" or "How many meetings today"
Expect: 4 sentences, 12s budget, no spillover

### Test LIST_QUERY Intent
Say: "Show me my emails" or "What's on my calendar"
Expect: 4 sentences, 15s budget, spillover enabled, "plus N more" pattern

### Test DEEP_DIVE Intent
Say: "Explain how the cluster works" or "Analyze the security incident"
Expect: 8 sentences, 30s budget, spillover enabled

### Test CHAT Intent
Say: "Hey Jarvis" or "Thanks"
Expect: 2 sentences, 5s budget, conversational style

### Test FOLLOW_UP Intent
Say: "Show me my emails" → wait for response → "Yes"
Expect: Continuation style matching previous response type

## Manual Classification Test

```javascript
import { classifyIntent } from './src/intent-classifier.js';

const result = classifyIntent({
  transcript: 'YOUR_TEST_PHRASE',
  speechDurationMs: 2000,
  conversationDepth: 0,
  isFollowUp: false,
  previousResponseType: null,
});

console.log(result);
```

## Adjusting Budgets

If you want to tune the budgets, edit `src/intent-classifier.js`:

```javascript
// For example, to make ACTION responses even briefer:
return buildBudget('ACTION', {
  maxSentences: 2,        // Was 3
  maxSpokenSeconds: 10,   // Was 15
  responseStyle: 'brief-confirm',
  spillover: true,
  budgetInstruction: 'RESPONSE BUDGET: Action task. Confirm in ≤2 sentences. What you did and one key metric.',
});
```

## Monitoring in Production

Add these metrics to track system effectiveness:

1. **Average response duration by intent type**
   - Track in Prometheus/Grafana
   - Alert if ACTION responses exceed 20s

2. **Classification distribution**
   - How many of each intent type per hour
   - Helps tune the classifier

3. **Barge-in rate**
   - How often users interrupt the bot
   - High rate = responses still too long

4. **Spillover usage**
   - How often users say "yes" to full details
   - Indicates whether summary is sufficient

5. **Conversation depth distribution**
   - Are multi-turn conversations working?
   - Average depth should be 2-4 for natural flow

## Emergency Bypass

If the system is causing issues, you can bypass classification temporarily:

```javascript
// In brain.js, comment out the classification:
export async function generateResponse(userMessage, history = [], classificationSignals = {}) {
  // const classification = classifyIntent({...});
  // Use a default instead:
  const classification = {
    type: 'QUERY',
    budgetInstruction: 'Be concise but helpful. 4-5 sentences max.',
    spillover: false,
  };
  // ... rest of function
}
```

This gives you a static budget while you debug.

## When to Adjust the Classifier

Consider adjusting when:
- **False positives:** Commands classified as wrong intent type
- **User feedback:** "Too long" or "not enough detail" consistently
- **New patterns:** User develops new speech patterns not covered
- **Context changes:** Different users, different domains

The classifier is rule-based, so it's easy to tune. Just update the regex patterns and budget values in `intent-classifier.js`.
