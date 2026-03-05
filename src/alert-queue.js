/**
 * Alert Queue - Stores pending voice alerts for briefing on join
 * 5-tier numeric priority: P1 (critical) through P5 (info)
 */

const pendingAlerts = [];
const MAX_ALERTS = 50;
const ALERT_TTL_MS = 4 * 60 * 60 * 1000; // Expire alerts older than 4 hours

/** Resolve numeric priority: explicit priorityLevel > string mapping > default 3 */
function getPri(a) {
  if (a.priorityLevel) return a.priorityLevel;
  if (a.priority === 'critical') return 1;
  if (a.priority === 'urgent') return 2;
  if (a.priority === 'low') return 4;
  if (a.priority === 'info') return 5;
  return 3; // 'normal' or unset
}

export function queueAlert(alert) {
  // Prune expired alerts first
  const now = Date.now();
  for (let i = pendingAlerts.length - 1; i >= 0; i--) {
    if (now - pendingAlerts[i].timestamp > ALERT_TTL_MS) {
      pendingAlerts.splice(i, 1);
    }
  }

  pendingAlerts.push({
    ...alert,
    timestamp: alert.timestamp || now,
    priority: alert.priority || 'normal',
    priorityLevel: alert.priorityLevel || null,
  });

  // Cap total alerts -- drop lowest priority (highest number) first
  while (pendingAlerts.length > MAX_ALERTS) {
    const lowest = Math.max(...pendingAlerts.map(a => getPri(a)));
    const idx = pendingAlerts.findIndex(a => getPri(a) === lowest);
    pendingAlerts.splice(idx >= 0 ? idx : pendingAlerts.length - 1, 1);
  }

  // Sort by numeric priority (lower = higher priority), then timestamp
  pendingAlerts.sort((a, b) => {
    const pa = getPri(a), pb = getPri(b);
    if (pa !== pb) return pa - pb;
    return a.timestamp - b.timestamp;
  });

  console.log(`📬 Alert queued [P${getPri(alert)}]: ${alert.message.substring(0, 50)}...`);
}

export function getPendingAlerts() {
  return [...pendingAlerts];
}

/** Get alerts filtered by max priority level (e.g. maxLevel=2 returns P1+P2 only) */
export function getAlertsByPriority(maxLevel = 5) {
  return pendingAlerts.filter(a => getPri(a) <= maxLevel);
}

export function clearAlerts() {
  const count = pendingAlerts.length;
  pendingAlerts.length = 0;
  console.log(`🗑️  Cleared ${count} alerts`);
  return count;
}

export function hasPendingAlerts() {
  return pendingAlerts.length > 0;
}
