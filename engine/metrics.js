/**
 * Metrics — Append-only JSONL logging for pipeline observability.
 */

import fs from 'fs/promises';
import path from 'path';

const METRICS_FILE = process.env.DEVNERDS_METRICS_FILE || './pipeline-metrics.jsonl';

/**
 * Log a metric entry (one per node execution).
 */
export async function logMetric(entry) {
  const record = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(METRICS_FILE, line);
}

/**
 * Read all metrics (for dashboard/analysis).
 */
export async function readMetrics() {
  try {
    const data = await fs.readFile(METRICS_FILE, 'utf-8');
    return data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Get metrics summary for a specific task.
 */
export async function getTaskMetrics(taskId) {
  const all = await readMetrics();
  return all.filter(m => m.taskId === taskId);
}

/**
 * Get aggregate stats for the last N days.
 */
export async function getAggregateStats(days = 7) {
  const all = await readMetrics();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const recent = all.filter(m => m.timestamp >= cutoff);

  const tasks = new Map();
  for (const m of recent) {
    if (!tasks.has(m.taskId)) tasks.set(m.taskId, []);
    tasks.get(m.taskId).push(m);
  }

  let totalCost = 0;
  let totalDuration = 0;
  let passed = 0;
  let failed = 0;

  for (const [taskId, nodes] of tasks) {
    const lastNode = nodes[nodes.length - 1];
    if (lastNode.verdict === 'SHIPPED' || lastNode.verdict === 'PASS') passed++;
    else if (lastNode.verdict === 'FAILED' || lastNode.verdict === 'FAIL' || lastNode.verdict === 'TIMEOUT') failed++;

    totalCost += nodes.reduce((sum, n) => sum + (n.cost_usd || 0), 0);
    totalDuration += nodes.reduce((sum, n) => sum + (n.duration_s || 0), 0);
  }

  return {
    period_days: days,
    total_tasks: tasks.size,
    passed,
    failed,
    success_rate: tasks.size > 0 ? (passed / tasks.size * 100).toFixed(1) + '%' : 'N/A',
    total_cost_usd: totalCost.toFixed(2),
    avg_cost_per_task: tasks.size > 0 ? (totalCost / tasks.size).toFixed(2) : 'N/A',
    total_duration_hours: (totalDuration / 3600).toFixed(1),
  };
}
