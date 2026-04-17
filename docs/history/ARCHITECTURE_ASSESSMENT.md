# Jarvis / OpenClaw / ZeroClaw Migration Assessment

## Current Runtime State

The live runtime is now:

- `jarvis-voice` remains the only Discord bot surface.
- OpenClaw Discord stays disabled in `~/.openclaw/openclaw.json`.
- OpenClaw direct ownership is retired from the active request path.
- ZeroClaw serves the backend agent runtime on `127.0.0.1:22101`.
- A thin compatibility adapter serves the legacy OpenClaw-shaped contract on `127.0.0.1:22100` for Jarvis.
- `jarvis-voice` still points at `http://127.0.0.1:22100`, so no frontend env churn was required for the cutover.
- `openclaw-gateway.service` and `openclaw-config-guard.timer` are disabled.

## What Was Stabilized First

Before any migration work, the OpenClaw baseline was tightened so the cutover point was deterministic:

- `jarvis-voice` became the only Discord owner.
- OpenClaw config drift remained enforced by `jarvis-health.sh` plus `openclaw-config-lock.sh`.
- `cursor-agent-wrapper` injects `--trust` for headless runs.
- OpenClaw CLI watchdog timeouts were raised to 15 minutes.
- Jarvis no longer has a live detached direct `cursor-agent` execution path for voice tasks.
- Async action tasks were normalized to a single webhook-style dispatch path.

## Migration Findings That Matter

### 1. ZeroClaw's OpenClaw migration command is not a full gateway/config migration

On this build, `zeroclaw migrate openclaw --dry-run` only previews import candidates from the OpenClaw workspace memory tree.

Observed dry-run result:

- source: `~/.openclaw/workspace`
- target: `~/.zeroclaw/workspace`
- candidates: 8 markdown entries
- no provider/channel/gateway translation report

That means the public “full import” story is not enough for this stack. Runtime migration must be treated as manual staging plus adapter work.

### 2. ZeroClaw's gateway contract does not match Jarvis's OpenClaw contract directly

Validated on the live cutover host:

- `GET /health` exists and works natively.
- `POST /webhook` exists and works natively.
- `POST /v1/chat/completions` is not provided by this ZeroClaw gateway build.
- `POST /hooks/agent` is not provided by this ZeroClaw gateway build.
- ZeroClaw's `/webhook` uses the configured runtime model, not a per-request model override.

That is why the compatibility adapter exists.

## Compatibility Adapter

The adapter lives at:

- `jarvis-voice/scripts/zeroclaw-openclaw-compat.js`

It provides:

- `GET /health` passthrough to ZeroClaw
- `POST /v1/chat/completions` with OpenAI-style response wrapping
- SSE-shaped streaming response for Jarvis's existing streaming code path
- `POST /hooks/agent` immediate acceptance with background execution against ZeroClaw `/webhook`
- async result delivery to Discord and `/speak` without relying on OpenClaw tool-side curl behavior

This is the thin sidecar that closed the migration gap without forcing a broad Jarvis rewrite.

## Parity Matrix

| Area | Current Runtime | ZeroClaw Status | Final Classification |
| --- | --- | --- | --- |
| Discord text routing | Jarvis frontend | kept in Jarvis | native frontend concern |
| Discord voice handoff | Jarvis frontend | kept in Jarvis | native frontend concern |
| Conversational backend | ZeroClaw via compat adapter | working | adapter |
| Async task dispatch | ZeroClaw via compat adapter | working | adapter |
| `/health` | ZeroClaw native | working | native |
| `/v1/chat/completions` | compat adapter -> ZeroClaw `/webhook` | working | adapter |
| `/hooks/agent` | compat adapter -> ZeroClaw `/webhook` | working | adapter |
| Session continuity | Jarvis session keys + adapter stateless pass-through | acceptable baseline | adapter-kept |
| Discord memory continuity | `discord-memory.js` | unchanged | keep in Jarvis |
| Cron/config import from OpenClaw | manual | incomplete | blocker for automatic migration |
| Browser/device-pair plugins | OpenClaw-specific | not migrated | out-of-scope blocker |
| Config guard / drift scripts | OpenClaw-only | retired from active runtime | decommissioned |

## Validation Matrix Used

### Direct backend checks

- `GET http://127.0.0.1:22101/health`
- `POST http://127.0.0.1:22101/webhook`
- `GET http://127.0.0.1:22100/health`
- `POST http://127.0.0.1:22100/v1/chat/completions`
- `POST http://127.0.0.1:22100/hooks/agent`

### Runtime checks

- ZeroClaw gateway systemd user service starts and stays healthy.
- Compatibility adapter systemd user service starts and stays healthy.
- Jarvis restarts cleanly after the cutover.
- OpenClaw services are disabled and inactive.

## Remaining Risks

- The adapter is intentionally narrow. If Jarvis starts depending on more of OpenClaw's private gateway surface, more shim work will be needed.
- The current ZeroClaw backend uses the environment-provided OpenAI key and a single configured model (`gpt-4o-mini`). Per-request model switching is not preserved.
- OpenClaw browser/device-pair features were not migrated into ZeroClaw.
- The automatic OpenClaw migration CLI did not import runtime config/channels for this stack.

## Operational End State

Enabled services:

- `jarvis-voice.service`
- `zeroclaw-gateway.service`
- `zeroclaw-openclaw-compat.service`

Disabled services:

- `openclaw-gateway.service`
- `openclaw-config-guard.timer`

Rollback path:

1. Stop `zeroclaw-openclaw-compat.service`.
2. Stop `zeroclaw-gateway.service`.
3. Re-enable and start `openclaw-gateway.service`.
4. Re-enable `openclaw-config-guard.timer` if config locking is needed again.
