/**
 * Baseline Check — Per-worktree infrastructure health check.
 *
 * Iterates each repo's worktree from artifacts.worktree_paths and verifies
 * the test runner / git state for that env_type. Aggregates results.
 *
 * Always returns PASSED unless infrastructure is genuinely broken in any repo.
 */

import { execSync } from 'child_process';
import fs from 'fs';

function checkOne(repoName, worktreePath, envType) {
  const warnings = [];
  const checks = [];

  // git status sanity (universal)
  try {
    const status = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf-8', timeout: 10_000 });
    if (status.includes('UU ') || status.includes('AA ') || status.includes('DD ')) {
      return { ok: false, error: `${repoName}: git has unresolved merge conflicts` };
    }
    checks.push('git: clean');
  } catch (err) {
    return { ok: false, error: `${repoName}: git status failed — ${err.message}` };
  }

  // Node-side: node_modules + vitest
  if (envType === 'node' || envType === 'python+node') {
    if (!fs.existsSync(`${worktreePath}/node_modules`)) {
      return { ok: false, error: `${repoName}: node_modules missing — run npm install` };
    }
    checks.push('node_modules: present');
    try {
      execSync('npx vitest --version 2>&1', { cwd: worktreePath, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' });
      checks.push('vitest: available');
    } catch {
      warnings.push(`${repoName}: vitest unavailable`);
    }
  }

  // Python-side: pytest
  if (envType === 'python' || envType === 'python+node') {
    try {
      execSync('python3 -m pytest --version 2>&1', { cwd: worktreePath, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' });
      checks.push('pytest: available');
    } catch {
      warnings.push(`${repoName}: pytest unavailable`);
    }
  }

  return { ok: true, checks, warnings };
}

export default function preFlight(task, artifacts, projectConfig) {
  const worktreePaths = artifacts?.worktree_paths || {};
  const repos = Object.keys(worktreePaths);

  if (repos.length === 0) {
    return { verdict: 'PASSED', summary: 'No worktrees to check' };
  }

  const allChecks = [];
  const allWarnings = [];

  for (const repo of repos) {
    const proj = projectConfig.projects?.[repo];
    if (!proj) {
      return { verdict: 'FAILED', error: `Unknown repo "${repo}" in worktree_paths` };
    }
    const result = checkOne(repo, worktreePaths[repo], proj.env_type);
    if (!result.ok) {
      return { verdict: 'FAILED', error: `Infrastructure broken: ${result.error}` };
    }
    allChecks.push(`${repo}: ${result.checks.join(', ')}`);
    if (result.warnings) allWarnings.push(...result.warnings);
  }

  // Disk space (one shared check)
  try {
    const df = execSync('df -m /tmp | tail -1', { encoding: 'utf-8', timeout: 5_000 });
    const availMB = parseInt(df.split(/\s+/)[3]);
    if (availMB < 500) allWarnings.push(`Low disk space in /tmp: ${availMB}MB free`);
  } catch { /* non-critical */ }

  return {
    verdict: 'PASSED',
    summary: `Baseline check passed for ${repos.length} repo(s)`,
    details: allChecks,
    warnings: allWarnings.length ? allWarnings : undefined,
  };
}
