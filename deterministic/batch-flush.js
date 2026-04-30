/**
 * Batch-Flush — Pushes accumulated local commits to origin/main.
 *
 * When batch_push is enabled, worktree-cleanup merges to local main but
 * skips the push. This node flushes all pending commits in a single push,
 * triggering CI/CD pipelines once instead of per-task.
 *
 * Can be run:
 *   - As a deterministic node in a blueprint
 *   - As a standalone script: node batch-flush.js <configPath>
 *   - Via cron or scheduler
 *
 * The push does NOT include [skip ci] so pipelines trigger normally.
 */

import { execSync } from 'child_process';
import Redis from 'ioredis';
import fs from 'fs';

const LOCK_KEY = 'devnerds:batch-flush:lock';
const LOCK_TTL_SECONDS = 120;
const BOT_EMAIL = process.env.DEVNERDS_BOT_EMAIL || 'devnerds-bot@example.com';

/**
 * Deterministic node entry point.
 */
export default async function batchFlush(task, artifacts, projectConfig) {
  if (!projectConfig.deploy?.batch_push) {
    return { verdict: 'PASSED', summary: 'batch_push not enabled — nothing to flush' };
  }

  return runFlush(projectConfig);
}

/**
 * Per-repo flush. Returns one of:
 *   { repo, status: 'noop' | 'flushed' | 'skipped' | 'failed', ... }
 */
async function flushOne(repo, repoPath) {
  try { execSync('git fetch origin main', { cwd: repoPath, timeout: 30_000, encoding: 'utf-8' }); } catch {}

  // Either ref can be absent on a fresh clone or a never-pushed repo. Treat as
  // a per-repo failure so the rest of the batch still flushes.
  let localHead, remoteHead;
  try {
    localHead = execSync('git rev-parse main', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    return { repo, status: 'failed', error: `local main not resolvable: ${err.message}` };
  }
  try {
    remoteHead = execSync('git rev-parse origin/main', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    return { repo, status: 'failed', error: `origin/main not resolvable: ${err.message}` };
  }

  if (localHead === remoteHead) {
    return { repo, status: 'noop', summary: 'local main matches origin/main' };
  }

  const pendingCount = execSync('git rev-list origin/main..main --count', { cwd: repoPath, encoding: 'utf-8' }).trim();
  console.log(`[Batch-Flush] ${repo}: ${pendingCount} commits pending → pushing`);

  try {
    execSync('git push origin main', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'DevNerds',
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: 'DevNerds',
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      },
    });
    console.log(`[Batch-Flush] ${repo}: pushed ${pendingCount} commits`);
    return { repo, status: 'flushed', commits_flushed: parseInt(pendingCount, 10), local_sha: localHead.slice(0, 7) };
  } catch (err) {
    return { repo, status: 'failed', error: err.message, summary: err.stderr || err.message };
  }
}

/**
 * Core flush logic — reusable from node or standalone.
 * Iterates every project in the multi-repo config.
 */
export async function runFlush(projectConfig) {
  const projects = projectConfig.projects || {};
  const repos = Object.entries(projects).filter(([, p]) => p.repo_path);

  if (repos.length === 0) {
    return { verdict: 'PASSED', summary: 'No projects with repo_path — nothing to flush' };
  }

  // Acquire Redis lock once for the whole batch.
  let redis = null;
  try {
    redis = new Redis({
      host: projectConfig.redis_host || 'localhost',
      port: projectConfig.redis_port || 6379,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    await redis.connect();

    const acquired = await redis.set(LOCK_KEY, process.pid.toString(), 'NX', 'EX', LOCK_TTL_SECONDS);
    if (!acquired) {
      await redis.quit();
      return { verdict: 'PASSED', summary: 'Another flush in progress — skipping' };
    }
  } catch {
    console.log('[Batch-Flush] Redis unavailable — proceeding without lock');
    redis = null;
  }

  try {
    const results = [];
    for (const [repo, project] of repos) {
      results.push(await flushOne(repo, project.repo_path));
    }

    const flushed = results.filter(r => r.status === 'flushed');
    const failed = results.filter(r => r.status === 'failed');
    const totalCommits = flushed.reduce((s, r) => s + (r.commits_flushed || 0), 0);

    if (failed.length > 0) {
      return {
        verdict: 'FAILED',
        error: `Batch push failed in ${failed.length}/${repos.length} repo(s): ${failed.map(f => f.repo).join(', ')}`,
        results,
      };
    }

    return {
      verdict: 'PASSED',
      summary: `Flushed ${totalCommits} commits across ${flushed.length}/${repos.length} repo(s)`,
      commits_flushed: totalCommits,
      results,
    };
  } finally {
    if (redis) {
      try { await redis.del(LOCK_KEY); await redis.quit(); }
      catch { try { redis.disconnect(); } catch {} }
    }
  }
}

/**
 * Standalone mode: node batch-flush.js <configPath>
 * Cron example (every 30 min):
 *   0,30 * * * * cd /path/to/devnerds && node deterministic/batch-flush.js config/devnerds.config.json
 */
const isStandalone = process.argv[1]?.endsWith('batch-flush.js') && process.argv.length > 2;
if (isStandalone) {
  const configPath = process.argv[2];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  runFlush(config)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.verdict === 'PASSED' ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
