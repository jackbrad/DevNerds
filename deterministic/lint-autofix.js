/**
 * Lint Auto-Fix — Per-repo lint pass with auto-fix.
 *
 * Runs in the for_each_repo loop (currentRepo provided) or, when called
 * without one, iterates all worktrees. Always non-blocking.
 */

import { execSync } from 'child_process';

function lintOne(repoName, worktreePath, projectConfig) {
  const proj = projectConfig.projects?.[repoName];
  if (!proj) return { repo: repoName, fixed: 0, warnings: [`unknown repo`] };
  const envType = proj.env_type;
  const fixed = [];
  const warnings = [];

  if (envType === 'node' || envType === 'python+node') {
    // Let eslint expand its own globs (no shell expansion) so we can actually
    // see its exit code instead of swallowing it with `|| true`.
    try {
      execSync('npx eslint --fix "src/**/*.{ts,tsx}"', {
        cwd: worktreePath, timeout: 30_000, stdio: 'pipe', encoding: 'utf-8',
      });
      fixed.push('eslint');
    } catch (err) {
      // eslint exits non-zero when unfixable issues remain — not an infra error.
      // Only surface as a warning so the pipeline keeps moving.
      const msg = (err.stdout || err.message || '').slice(0, 200);
      warnings.push(`${repoName}/eslint: ${msg}`);
    }
  }

  if (envType === 'python' || envType === 'python+node') {
    // No equivalent of eslint --fix for python in the current setup. Non-blocking.
  }

  return { repo: repoName, fixed: fixed.length, warnings };
}

export default function lintAutofix(task, artifacts, projectConfig, currentRepo) {
  const worktreePaths = artifacts?.worktree_paths || {};
  const repos = currentRepo ? [currentRepo] : Object.keys(worktreePaths);

  const results = [];
  for (const repo of repos) {
    const wt = worktreePaths[repo];
    if (!wt) continue;
    results.push(lintOne(repo, wt, projectConfig));
  }

  const totalFixed = results.reduce((acc, r) => acc + r.fixed, 0);
  return {
    verdict: 'PASSED',
    summary: `Lint auto-fix: ${totalFixed} fix-passes across ${results.length} repo(s)`,
    issues_fixed: totalFixed,
    results,
  };
}
