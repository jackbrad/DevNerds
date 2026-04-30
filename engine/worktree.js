/**
 * Worktree Manager — Creates and destroys isolated git worktrees per task.
 *
 * Multi-repo aware: a single task can touch N repos, each gets its own worktree.
 * Worktree path: /tmp/dn-<taskId>-<repo>. Branch: devnerds/<taskId>.
 */

import { execSync } from 'child_process';
import fs from 'fs';

const WORKTREE_BASE = '/tmp';

function worktreePathFor(taskId, repoName) {
  return `${WORKTREE_BASE}/dn-${taskId}-${repoName}`;
}

function projectFor(projectConfig, repoName) {
  const proj = projectConfig.projects?.[repoName];
  if (!proj) throw new Error(`Unknown repo "${repoName}" — not in config.projects`);
  return proj;
}

/**
 * Create a single worktree for one repo.
 */
function createOneWorktree(taskId, repoName, projectConfig) {
  const proj = projectFor(projectConfig, repoName);
  const repoPath = proj.repo_path;
  const worktreePath = worktreePathFor(taskId, repoName);
  const branchName = `devnerds/${taskId}`;

  // Clean up stale worktree
  if (fs.existsSync(worktreePath)) {
    console.log(`[Worktree] Cleaning stale worktree for ${taskId}/${repoName}`);
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath, encoding: 'utf-8' });
    } catch {
      execSync(`rm -rf "${worktreePath}"`, { encoding: 'utf-8' });
      execSync('git worktree prune', { cwd: repoPath, encoding: 'utf-8' });
    }
  }

  // Delete stale branch
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* branch missing — fine */ }

  // Refresh remote-tracking ref so we fork from the freshest upstream.
  let haveFetch = true;
  try {
    execSync('git fetch origin main 2>&1', { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 });
  } catch {
    haveFetch = false;
    console.log(`[Worktree] git fetch failed for ${repoName}, falling back to local main`);
  }

  // Fork from origin/main (post-fetch) instead of local main — local main
  // doesn't get fast-forwarded when prior tasks atomic-push directly to
  // origin/main, so using local main here would silently start each new
  // task on a stale base and atomic-push would later be rejected as
  // "behind". If fetch failed, fall back to local main.
  const sourceRef = haveFetch ? 'origin/main' : 'main';
  execSync(`git worktree add -b "${branchName}" "${worktreePath}" ${sourceRef}`, {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  // Symlink node_modules per repo if present
  const srcModules = `${repoPath}/node_modules`;
  const dstModules = `${worktreePath}/node_modules`;
  if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
    fs.symlinkSync(srcModules, dstModules);
    console.log(`[Worktree] Symlinked node_modules into ${worktreePath}`);
  }

  console.log(`[Worktree] Created: ${worktreePath} (branch: ${branchName})`);
  return worktreePath;
}

/**
 * Create worktrees for a list of repos. Returns { repoName: worktreePath }.
 */
export function createWorktreesForTask(taskId, repos, projectConfig) {
  const out = {};
  for (const repo of repos) {
    out[repo] = createOneWorktree(taskId, repo, projectConfig);
  }
  return out;
}

/**
 * Remove a single repo's worktree + branch.
 */
function removeOneWorktree(taskId, repoName, projectConfig) {
  const proj = projectFor(projectConfig, repoName);
  const repoPath = proj.repo_path;
  const worktreePath = worktreePathFor(taskId, repoName);
  const branchName = `devnerds/${taskId}`;

  try {
    if (fs.existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath, encoding: 'utf-8' });
      console.log(`[Worktree] Removed: ${worktreePath}`);
    }
  } catch (err) {
    console.error(`[Worktree] Failed to remove ${worktreePath}: ${err.message}`);
    try {
      execSync(`rm -rf "${worktreePath}"`, { encoding: 'utf-8' });
      execSync('git worktree prune', { cwd: repoPath, encoding: 'utf-8' });
    } catch {}
  }

  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* gone — fine */ }
}

/**
 * Remove all worktrees for a task across the given repos.
 */
export function removeWorktreesForTask(taskId, repos, projectConfig) {
  for (const repo of repos) {
    try { removeOneWorktree(taskId, repo, projectConfig); } catch (err) {
      console.error(`[Worktree] Cleanup error for ${repo}: ${err.message}`);
    }
  }
}

/**
 * On engine startup, scan all configured repos for orphaned devnerds/* branches and delete them.
 * Worktrees in /tmp/dn-* are also pruned by age.
 */
export function cleanupOrphanedBranches(projectConfig) {
  const projects = projectConfig.projects || {};
  let deleted = 0;

  for (const [repoName, proj] of Object.entries(projects)) {
    const repoPath = proj.repo_path;
    if (!fs.existsSync(repoPath)) continue;

    // Prune worktree refs that no longer have a directory
    try { execSync('git worktree prune', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }); } catch {}

    let branches = '';
    try {
      branches = execSync('git branch --list "devnerds/*"', { cwd: repoPath, encoding: 'utf-8' });
    } catch { continue; }

    for (const raw of branches.split('\n')) {
      const branch = raw.replace('*', '').trim();
      if (!branch) continue;
      try {
        execSync(`git branch -D "${branch}"`, { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' });
        deleted++;
        console.log(`[Worktree] Cleaned orphan branch ${branch} in ${repoName}`);
      } catch { /* branch in use by a live worktree — skip */ }
    }
  }

  if (deleted > 0) console.log(`[Worktree] Cleaned ${deleted} orphan devnerds/* branch(es).`);
}

/**
 * Prune stale /tmp/dn-* worktree directories older than maxAgeMs.
 * Called on worker startup.
 */
export function pruneStaleWorktrees(projectConfig, maxAgeMs = 3_600_000) {
  const projects = projectConfig.projects || {};
  let pruned = 0;

  try {
    const entries = fs.readdirSync(WORKTREE_BASE);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith('dn-')) continue;
      const fullPath = `${WORKTREE_BASE}/${entry}`;
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        const ageMs = now - stat.mtimeMs;
        if (ageMs <= maxAgeMs) continue;

        // Try to detach via any matching repo, then force rm
        let detached = false;
        for (const proj of Object.values(projects)) {
          try {
            execSync(`git worktree remove "${fullPath}" --force`, { cwd: proj.repo_path, encoding: 'utf-8', stdio: 'pipe' });
            detached = true; break;
          } catch { /* try next */ }
        }
        if (!detached) execSync(`rm -rf "${fullPath}"`, { encoding: 'utf-8' });
        pruned++;
      } catch { /* skip */ }
    }

    for (const proj of Object.values(projects)) {
      try { execSync('git worktree prune', { cwd: proj.repo_path, encoding: 'utf-8', stdio: 'pipe' }); } catch {}
    }
  } catch (err) {
    console.error(`[Worktree] Prune failed: ${err.message}`);
  }

  if (pruned > 0) console.log(`[Worktree] Pruned ${pruned} stale worktree dir(s).`);
}
