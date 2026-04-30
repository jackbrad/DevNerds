/**
 * Atomic Push — After EVALUATE passes, push every repo's changes directly
 * to origin/main from inside the worktree. Bypasses the user's main repo
 * checkout entirely to avoid untracked-file merge conflicts.
 *
 * Strategy (per repo):
 *   1. Compare local HEAD vs origin/main — skip if already pushed
 *   2. If local is ahead of remote (fast-forward): push
 *   3. If remote is unreachable from local (diverged/behind): error LOUD
 *   4. On non-fast-forward push rejection: fetch + rebase, retry once
 *   5. On rebase conflict OR retry rejection: throw — fail this repo
 *
 * Partial-failure behavior:
 *   - Collect per-repo results instead of throwing immediately
 *   - Return PARTIAL_FAILURE with keepNode:true so the engine leaves the
 *     task at atomic-push (not cleanup-on-failure)
 *   - Re-running the handler skips already-pushed repos (idempotent)
 *
 * After all repos succeed: clean up any orphan task branch on origin.
 */

import { execSync } from 'child_process';
import { alertTaskFailed } from '../engine/notify.js';

const BOT_EMAIL = process.env.DEVNERDS_BOT_EMAIL || 'devnerds-bot@example.com';

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'DevNerds',
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: 'DevNerds',
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  };
}

/**
 * Resolve the current HEAD SHA in a worktree.
 */
function localHead(wt) {
  return execSync('git rev-parse HEAD', {
    cwd: wt, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
  }).trim();
}

/**
 * Resolve origin/main HEAD via ls-remote (no local fetch required).
 * Returns null if the remote ref is absent (brand-new repo, first push).
 */
function remoteHead(wt) {
  const out = execSync('git ls-remote origin refs/heads/main', {
    cwd: wt, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
  }).trim();
  if (!out) return null;
  return out.split(/\s+/)[0];
}

/**
 * Returns true when <ancestor> is reachable from HEAD (i.e. local is ahead).
 */
function isAncestorOfHead(wt, ancestor) {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} HEAD`, {
      cwd: wt, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push local HEAD to origin/main.
 * Returns true on success.
 * Throws a descriptive Error on unrecoverable failure.
 */
function pushWorktreeToMain(repo, wt) {
  // --- Idempotency check ---
  const local = localHead(wt);
  const remote = remoteHead(wt);

  if (remote !== null && local === remote) {
    console.log(`[AtomicPush] ${repo} already at origin/main (${local.slice(0, 8)}) — skipping`);
    return 'skipped';
  }

  // Note: don't bail early on "behind/diverged" — the rebase fallback below
  // is built specifically for that case (typically: another task pushed to
  // origin/main while this task was in flight). Bailing here would force
  // human intervention on a routine race that the engine can resolve.

  // --- Direct push ---
  try {
    execSync('git push origin HEAD:refs/heads/main', {
      cwd: wt, encoding: 'utf-8', timeout: 60_000, env: gitEnv(),
    });
    console.log(`[AtomicPush] ${repo} pushed HEAD -> origin/main`);
    return 'pushed';
  } catch (pushErr) {
    const msg = pushErr.message || '';
    const stderr = (pushErr.stderr || '').toString();
    const combined = `${msg}\n${stderr}`;
    const isRejected = combined.includes('rejected') ||
                       combined.includes('non-fast-forward') ||
                       combined.includes('fetch first') ||
                       combined.includes('behind its remote');
    if (!isRejected) throw pushErr;
  }

  // --- Non-fast-forward: fetch + rebase, retry once ---
  console.log(`[AtomicPush] ${repo} non-fast-forward — fetching and rebasing...`);
  try {
    execSync('git fetch origin main', { cwd: wt, encoding: 'utf-8', timeout: 60_000 });
    execSync('git rebase origin/main', { cwd: wt, encoding: 'utf-8', env: gitEnv() });
  } catch (rebaseErr) {
    try { execSync('git rebase --abort', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' }); } catch {}
    throw new Error(`[AtomicPush] ${repo} rebase conflict after fetch — manual intervention required: ${rebaseErr.message}`);
  }

  try {
    execSync('git push origin HEAD:refs/heads/main', {
      cwd: wt, encoding: 'utf-8', timeout: 60_000, env: gitEnv(),
    });
    console.log(`[AtomicPush] ${repo} pushed HEAD -> origin/main (after rebase)`);
    return 'pushed';
  } catch (retryErr) {
    throw new Error(`[AtomicPush] ${repo} push failed after rebase: ${retryErr.message}`);
  }
}

export default async function atomicPush(task, artifacts, projectConfig) {
  const buildOrder = artifacts?.build_order || [];

  // Fall back: derive from worktree_paths keys if build_order missing
  const order = buildOrder.length > 0
    ? buildOrder
    : Object.keys(artifacts?.worktree_paths || {});

  const worktreePaths = artifacts?.worktree_paths || {};
  if (order.length === 0) {
    return { verdict: 'PASSED', summary: 'Nothing to push — no build_order' };
  }

  const branchName = `devnerds/${task.id}`;

  const pushed = [];
  const skipped = [];
  const failed = [];

  for (const repo of order) {
    const proj = projectConfig.projects?.[repo];
    if (!proj) {
      failed.push({ repo, error: `unknown repo in build_order: ${repo}` });
      continue;
    }
    const wt = worktreePaths[repo];
    if (!wt) {
      failed.push({ repo, error: `no worktree path recorded for ${repo}` });
      continue;
    }

    try {
      const outcome = pushWorktreeToMain(repo, wt);
      if (outcome === 'skipped') {
        skipped.push(repo);
      } else {
        pushed.push(repo);
      }
    } catch (err) {
      console.error(`[AtomicPush] ${repo} FAILED: ${err.message}`);
      failed.push({ repo, error: err.message });
    }
  }

  // --- Partial failure: stay at this node for retry ---
  if (failed.length > 0) {
    const failedRepos = failed.map(f => f.repo).join(', ');
    const reason = `atomic-push: ${pushed.length + skipped.length} of ${order.length} repos pushed. Failed: ${failedRepos}`;
    console.error(`[AtomicPush] PARTIAL FAILURE — ${reason}`);

    try {
      await alertTaskFailed(task.id, 'atomic-push', reason);
    } catch (notifyErr) {
      console.error(`[AtomicPush] alert failed: ${notifyErr.message}`);
    }

    return {
      verdict: 'FAILED',
      failureReason: reason,
      keepNode: true,
      results: { pushed, skipped, failed },
    };
  }

  // --- All succeeded: clean up orphan task branch on origin ---
  for (const repo of order) {
    const wt = worktreePaths[repo];
    if (!wt) continue;
    try {
      execSync(`git push origin --delete "${branchName}"`, {
        cwd: wt, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
      });
      console.log(`[AtomicPush] ${repo} deleted orphan branch ${branchName} on origin`);
    } catch {
      // Branch may not exist on origin — ignore
    }
  }

  const allCount = pushed.length + skipped.length;
  return {
    verdict: 'PASSED',
    summary: `Pushed ${pushed.length} repo(s), skipped ${skipped.length} already-current. Total: ${allCount}/${order.length}`,
    results: { pushed, skipped, failed: [] },
  };
}
