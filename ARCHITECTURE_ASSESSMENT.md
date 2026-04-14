# Jarvis Architecture Assessment: The Path to "Zero-Claw"

## 1. Current State & The Cost Problem

Right now, the architecture is a hybrid that is accidentally expensive:
*   **Jarvis Voice (Frontend):** Handles wake word, STT (Whisper), TTS (Kokoro/Piper), and Discord integration.
*   **OpenClaw (Middleman):** Currently used for conversational responses (`generateResponse`) and some legacy webhook dispatching. OpenClaw is heavy—it wraps requests in agent loops and isn't optimized for raw, cheap conversational routing.
*   **Cursor Agent (Backend Hack):** Because Anthropic blocked Claude Code, we are routing heavy tasks to `cursor-agent`. This uses your company Cursor Pro account (which has a hard limit of ~500 fast requests).
*   **hAIveMind & MCP:** Jarvis is already starting to manage memory directly via `mcporter` or direct HTTP fetches, bypassing OpenClaw's memory.

**The Danger Zone:** Heartbeats, cron jobs, and frequent conversational turns hitting OpenClaw (and by extension, heavy models or Cursor) will silently drain your Cursor Pro quota and run up API bills. 

## 2. Moving to "Zero-Claw" (Bypassing OpenClaw)

Moving to a "Zero-Claw" architecture (removing OpenClaw entirely from the Jarvis stack) is highly recommended. You've already done 50% of the work by implementing `dispatchViaCursorAgent` directly in `brain.js`.

### Is it a big lift?
**No, it's a medium-to-small lift.** 
Jarvis Voice already does almost everything. The only things OpenClaw still does for you are:
1.  **Conversational Chat Generation:** `brain.js` calls OpenClaw's `/v1/chat/completions`. We can easily swap this to point directly to a cheap API (like OpenRouter for Gemini 3.1 Pro/Haiku) or a local Ollama model.
2.  **Tool Execution for Conversational Queries:** OpenClaw provides tools to the conversational model. But we can handle simple tools (like time, weather) locally, and route everything else to a `cursor-agent` sub-task.

### The "Lean & Useful" Zero-Claw Architecture

To protect your Cursor account and wallet, we need a strict tiered routing system entirely contained within Jarvis:

*   **Tier 1: Conversational / Chit-Chat / ACKs (Extremely Cheap/Free)**
    *   **Tech:** Local Ollama (Qwen3 4B/8B) or a direct API to Gemini 3.1 Flash / Claude 3.5 Haiku.
    *   **Cost:** $0 (Local) or fractions of a cent (API).
    *   **Role:** Answering "how are you", providing fast ACKs ("On it, sir"), checking the time, and determining *if* a heavy agent needs to be spawned.

*   **Tier 2: Background Tasks / Cron / Heartbeats (Cheap)**
    *   **Tech:** Direct API to Gemini 3.1 Pro or Claude 3.5 Sonnet (using personal API keys, strictly metered), or powerful local models (Qwen 32B).
    *   **Role:** Periodic system checks, reading logs, summarizing Discord. These should *never* use `cursor-agent` to protect the 500 fast-request pool.

*   **Tier 3: Heavy Lifting / Coding / Deep Investigations (Premium)**
    *   **Tech:** `cursor-agent` CLI (using Cursor Pro quota) or Claude 3.7 Sonnet / Opus.
    *   **Role:** Executed *only* on explicit command (e.g., "Jarvis, fix the bug in the proxy").

## 3. Cursor Agent & Gemini Pricing

*   **Cursor Agent Quota:** You have 500 "fast" requests per month on Pro. Agent loops burn through these extremely fast because each tool call/step in an agent's thought process is a separate request. Using it for background tasks will drain it in hours.
*   **Gemini 3.1 Pro:** While Gemini is generally cheaper than Claude via direct API, when routed through `cursor-agent`, it still consumes your premium Cursor request quota. To save money, we should only use `cursor-agent` when we actually need it to edit your codebase.

## 4. Next Steps for Implementation

If we pull the trigger on "Zero-Claw", here is the immediate roadmap:

1.  **Rip out OpenClaw routing:** Change `COMPLETIONS_URL` in `brain.js` to hit a direct LLM API (OpenRouter/Anthropic/Google) or Local Ollama instead of OpenClaw.
2.  **Move Tool Logic:** Implement a lightweight local tool-router in `jarvis-voice` for basic commands (check memory, read calendar) so it doesn't need to spawn a full agent just to check your schedule.
3.  **Strict Isolation:** Ensure `cursor-agent` is strictly gated behind an explicit "Task Dispatch" intent, ensuring it is never accidentally triggered by a conversational heartbeat.