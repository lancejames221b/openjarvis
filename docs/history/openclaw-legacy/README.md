# Legacy: OpenClaw / ZeroClaw

This directory contains historical playbooks from when Jarvis was backed by the "OpenClaw" / "ZeroClaw"
dispatch infrastructure (Cursor-based Claude proxy). That architecture was retired in April 2026 after
Anthropic tightened rules around indirect/proxied Claude access.

The current architecture uses the official `claude -p` CLI directly. See:
- [docs/MULTI_ACCOUNT.md](../MULTI_ACCOUNT.md) — per-channel account routing
- [scripts/jarvis-gateway.js](../../scripts/jarvis-gateway.js) — the new gateway
- [QUICKSTART.md](../../QUICKSTART.md) — getting started
