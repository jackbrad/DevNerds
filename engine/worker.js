/**
 * Worker — Picks jobs from BullMQ queue and executes blueprints.
 *
 * Includes a circuit breaker that pauses the queue after consecutive
 * failures with the same error signature.
 *
 * Run: node engine/worker.js [configPath]
 */

import { Worker, Queue } from 'bullmq';
import { executeBlueprint } from './blueprint-engine.js';
import { loadConfig } from './config.js';
import { updateTaskStatus, getTask } from './task-db.js';

// Statuses that signal the task should NOT run, even if a job for it lands
// in the queue. Worker checks current DDB status before claiming.
const SKIP_STATUSES = new Set(['BLOCKED', 'CLOSED', 'STOPPED', 'DONE', 'MERGED', 'VERIFIED']);
import { alertTaskFailed, alertInfra } from './notify.js';
import { runFlush } from '../deterministic/batch-flush.js';
import { pruneStaleWorktrees, cleanupOrphanedBranches } from './worktree.js';

const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 300_000;
let consecutiveFailures = 0;
let lastFailureSignature = null;
let breakerTripped = false;
let breakerTrippedAt = null;

const INFRA_SIGNATURES = [
  'BASELINE_BROKEN',
  'TEST_SUITE_CRASH',
  'SPAWN_FAILURE',
  'DB_ERROR',
  'WORKTREE_FAILURE',
];

function getFailureSignature(result) {
  const reason = result.failureReason || result.error || '';
  if (reason.includes('Baseline broken') || reason.includes('Infrastructure broken')) return 'BASELINE_BROKEN';
  if (reason.includes('test suite crashed') || reason.includes('runner crash'))        return 'TEST_SUITE_CRASH';
  if (reason.includes('spawn') || reason.includes('ENOENT'))                            return 'SPAWN_FAILURE';
  if (reason.includes('DynamoDB') || reason.includes('Throttling'))                     return 'DB_ERROR';
  if (reason.includes('worktree'))                                                       return 'WORKTREE_FAILURE';
  return 'TASK_FAILURE';
}

function checkCircuitBreaker(result, worker) {
  if (result.success) {
    consecutiveFailures = 0;
    lastFailureSignature = null;
    return;
  }
  const sig = getFailureSignature(result);

  if (!INFRA_SIGNATURES.includes(sig)) {
    console.log(`[CIRCUIT BREAKER] Task-level failure (${sig}) — not counted toward breaker.`);
    return;
  }

  if (sig === lastFailureSignature) consecutiveFailures++;
  else { consecutiveFailures = 1; lastFailureSignature = sig; }

  if (consecutiveFailures >= BREAKER_THRESHOLD && !breakerTripped) {
    breakerTripped = true;
    breakerTrippedAt = Date.now();
    console.error(`\n[CIRCUIT BREAKER] TRIPPED after ${consecutiveFailures} consecutive "${sig}" infrastructure failures`);
    console.error('[CIRCUIT BREAKER] Queue PAUSED. Will auto-resume in 5 min or restart worker to resume now.');

    worker.pause();

    alertInfra(
      'Circuit breaker tripped',
      `Pipeline paused after ${consecutiveFailures} consecutive infrastructure failures.\n\nFailure signature: ${sig}\nLast failure reason: ${result.failureReason || result.error}\n\nThe queue is paused. Fix the root cause, then restart the worker (pm2 restart devnerds-worker) to resume.`
    );

    setTimeout(() => {
      if (breakerTripped) {
        console.log('[CIRCUIT BREAKER] Cooldown expired, resuming queue...');
        breakerTripped = false;
        consecutiveFailures = 0;
        lastFailureSignature = null;
        worker.resume();
      }
    }, BREAKER_COOLDOWN_MS);
  }
}

async function loadPipeline() {
  const { default: pipeline } = await import('../blueprints/pipeline.js');
  return pipeline;
}

async function startWorker(configPath) {
  const config = await loadConfig(configPath);

  console.log('[Worker] Starting DevNerds worker...');
  console.log(`[Worker] Queue: devnerds-tasks | Redis: ${config.redis_host || 'localhost'}:${config.redis_port || 6379}`);
  console.log(`[Worker] Circuit breaker: ${BREAKER_THRESHOLD} consecutive infrastructure failures → pause`);

  // Multi-repo: prune stale /tmp/dn-* AND clean orphan devnerds/* branches across all configured repos.
  pruneStaleWorktrees(config);
  cleanupOrphanedBranches(config);

  const worker = new Worker('devnerds-tasks', async (job) => {
    const { taskId, task, domain } = job.data;

    console.log(`\n[Worker] Processing ${taskId} (domain=${domain})`);

    // Sanity-check current DDB status before claiming. If the task was
    // BLOCKED/CLOSED/STOPPED/DONE/etc. between enqueue and claim, the
    // queued job is stale — drop it instead of resurrecting the run.
    let currentStatus = null;
    try {
      const fresh = await getTask(taskId, config);
      currentStatus = fresh?.status || null;
    } catch (err) {
      console.warn(`[Worker] Could not read current status for ${taskId}: ${err.message} — proceeding`);
    }
    if (currentStatus && SKIP_STATUSES.has(currentStatus)) {
      console.log(`[Worker] ${taskId} skipped — current status is ${currentStatus} (job is stale)`);
      return { success: false, finalVerdict: 'SKIPPED', reason: `task status was ${currentStatus} at claim time` };
    }

    try {
      await updateTaskStatus(taskId, 'IN_PROGRESS', config);
      console.log(`[Worker] ${taskId} → IN_PROGRESS`);
    } catch (err) {
      console.error(`[Worker] Failed to set IN_PROGRESS: ${err.message}`);
    }

    const pipeline = await loadPipeline();
    const result = await executeBlueprint(task, pipeline, config);

    console.log(`[Worker] ${taskId} → ${result.finalVerdict} (${result.totalDuration_s?.toFixed(1)}s)`);

    checkCircuitBreaker(result, worker);

    if (!result.success) {
      console.log(`[Worker] Failed at node: ${result.failedNode} — ${result.failureReason}`);
      if (!breakerTripped) {
        await alertTaskFailed(taskId, result.failedNode, result.failureReason);
      }
    }

    return result;
  }, {
    connection: { host: config.redis_host || 'localhost', port: config.redis_port || 6379 },
    concurrency: config.worker_concurrency || 1,
    lockDuration: 600_000,
    lockRenewTime: 300_000,
    stalledInterval: 900_000,
  });

  const redisConnection = { host: config.redis_host || 'localhost', port: config.redis_port || 6379 };
  const queue = new Queue('devnerds-tasks', { connection: redisConnection });

  worker.on('completed', async (job, result) => {
    console.log(`[Worker] Job ${job.id} completed: ${result.finalVerdict}`);

    // batch_push runs per-repo via atomic-push now; the legacy single-repo flush
    // is only used when explicitly enabled in config.deploy.batch_push.
    if (config.deploy?.batch_push && result.finalVerdict === 'DONE') {
      try {
        const waiting = await queue.getWaitingCount();
        const active = await queue.getActiveCount();
        if (waiting === 0 && active === 0) {
          console.log('[Worker] Queue drained — flushing batch (legacy single-repo path)');
          const flushResult = await runFlush(config);
          console.log(`[Worker] Batch flush: ${flushResult.summary}`);
        }
      } catch (err) {
        console.error(`[Worker] Batch flush check failed: ${err.message}`);
      }
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job.id} failed:`, err.message);
    alertInfra('Worker job crash', `Job ${job.id} (${job.data?.taskId}): ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Error:', err.message);
    if (err.message.includes('lock') || err.message.includes('Missing lock')) return;
    alertInfra('Worker process error', err.message);
  });

  console.log('[Worker] Listening for jobs...');

  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] ${signal} received, waiting for in-flight job to finish...`);

    // Arm the hard-fallback timer BEFORE awaiting close, so a stalled
    // BullMQ lock can't keep the process alive forever.
    const forceExit = setTimeout(() => {
      console.error('[Worker] Shutdown timeout — force exiting.');
      process.exit(1);
    }, 300_000);
    forceExit.unref();

    try {
      await worker.close();
      clearTimeout(forceExit);
      console.log('[Worker] Shutdown complete (job finished).');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      console.error(`[Worker] Shutdown error: ${err.message}`);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startWorker(process.argv[2]).catch(err => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
