/**
 * Auto-Commit — Commits build changes per repo.
 *
 * Two modes (for_each_repo aware):
 * - currentRepo provided: commit only that repo's worktree
 * - currentRepo absent: iterate all worktree_paths, commit each
 *
 * Stages only files that differ from main (NOT git add -A) so we never
 * sweep in unrelated edits.
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BOT_EMAIL = process.env.DEVNERDS_BOT_EMAIL || 'devnerds-bot@example.com';

function commitOne(task, repoName, worktreePath, projectConfig) {
  const status = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf-8' }).trim();
  if (!status) {
    return { repo: repoName, ok: true, skipped: true, summary: 'No changes to commit' };
  }

  try {
    const diffOutput = execSync('git diff --name-only main', { cwd: worktreePath, encoding: 'utf-8' }).trim();
    const newFiles = execSync('git ls-files --others --exclude-standard', { cwd: worktreePath, encoding: 'utf-8' }).trim();
    const filesToStage = [
      ...diffOutput.split('\n').filter(Boolean),
      ...newFiles.split('\n').filter(Boolean),
    ];

    if (filesToStage.length === 0) {
      return { repo: repoName, ok: true, skipped: true, summary: 'No task-scoped changes' };
    }

    for (const file of filesToStage) {
      try {
        execSync(`git add "${file}"`, { cwd: worktreePath, encoding: 'utf-8' });
      } catch {
        execSync(`git rm --cached "${file}" 2>/dev/null || true`, { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' });
      }
    }

    // Re-check staged set after add loop (some files may have been gitignored/rejected)
    const stagedAfterAdd = execSync('git diff --cached --name-only', { cwd: worktreePath, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    if (stagedAfterAdd.length === 0) {
      return { repo: repoName, ok: true, skipped: true, summary: 'No task-scoped changes (all files gitignored or already clean)' };
    }

    // Safety check: refuse to commit if any staged path (being added/modified, not deleted)
    // looks like sensitive/build output. Deletions are always safe.
    const FORBIDDEN_PATTERNS = [
      /^node_modules$/,
      /^node_modules\//,
      /^dist$/,
      /^dist\//,
      /^build$/,
      /^build\//,
      /^\.omc$/,
      /^\.omc\//,
      /^\.env$/,
      /\.env\./,
      /\.pem$/,
      /\.key$/,
      /(^|\/)__pycache__\//,
      /\.pyc$/,
      /\.pyo$/,
      /^id_rsa/,
    ];
    // Symlink mode is 120000 in git's raw diff output
    const FORBIDDEN_SYMLINK_BASENAMES = /^(node_modules|dist|build|\.omc)$/;
    // Use --raw to get both status (A/M/D/R) and mode in one pass
    const rawDiff = execSync('git diff --cached --raw', { cwd: worktreePath, encoding: 'utf-8' }).trim();
    for (const rawLine of rawDiff.split('\n').filter(Boolean)) {
      const parts = rawLine.split('\t');
      const meta = parts[0]; // e.g. ":100644 120000 <sha> <sha> A"
      const metaParts = meta.split(' ');
      const dstMode = metaParts[1];
      const statusChar = metaParts[4]?.[0]; // A, M, D, R, C, ...
      const destPath = parts[parts.length - 1];
      // Skip deletions — removing a forbidden path is always safe
      if (statusChar === 'D') continue;
      // Refuse forbidden path names (additions/modifications only)
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(destPath)) {
          return {
            repo: repoName,
            ok: false,
            error: `auto-commit refuses: "${destPath}" is in the staged set; tighten .gitignore`,
            summary: `auto-commit refuses: "${destPath}" is in the staged set; tighten .gitignore`,
          };
        }
      }
      // Refuse symlinks whose basename matches a forbidden name (mode 120000)
      if (dstMode === '120000') {
        const basename = path.basename(destPath);
        if (FORBIDDEN_SYMLINK_BASENAMES.test(basename)) {
          return {
            repo: repoName,
            ok: false,
            error: `auto-commit refuses: "${destPath}" is a symlink to a forbidden target; tighten .gitignore`,
            summary: `auto-commit refuses: "${destPath}" is a symlink to a forbidden target; tighten .gitignore`,
          };
        }
      }
    }

    const message = `[${task.id}] ${task.title}\n\nAutomated commit by DevNerds pipeline (${repoName})`;
    // Pass message via stdin so titles with quotes/backticks/$ can't break shell parsing.
    execFileSync('git', ['commit', '-F', '-'], {
      cwd: worktreePath,
      input: message,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'DevNerds',
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: 'DevNerds',
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      },
    });

    let fullHash = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim();

    // Update build marker if configured AND present in this repo
    const marker = projectConfig.deploy?.build_marker;
    if (marker?.file) {
      const markerPath = path.join(worktreePath, marker.file);
      if (fs.existsSync(markerPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
          if (marker.sha_field) data[marker.sha_field] = fullHash;
          if (marker.task_field) data[marker.task_field] = task.id;
          if (marker.timestamp_field) data[marker.timestamp_field] = new Date().toISOString();
          if ('commit' in data && marker.sha_field !== 'commit') data.commit = fullHash;
          fs.writeFileSync(markerPath, JSON.stringify(data, null, 2) + '\n');

          execSync(`git add "${marker.file}"`, { cwd: worktreePath, encoding: 'utf-8' });
          execSync('git commit --amend --no-edit', {
            cwd: worktreePath, encoding: 'utf-8',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'DevNerds',
              GIT_AUTHOR_EMAIL: BOT_EMAIL,
              GIT_COMMITTER_NAME: 'DevNerds',
              GIT_COMMITTER_EMAIL: BOT_EMAIL,
            },
          });
          fullHash = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim();
        } catch (markerErr) {
          console.error(`[AutoCommit] Marker update failed in ${repoName}: ${markerErr.message}`);
        }
      }
    }

    return {
      repo: repoName,
      ok: true,
      summary: `${repoName}: committed ${filesToStage.length} file(s) as ${fullHash.slice(0, 7)}`,
      commit_hash: fullHash.slice(0, 7),
      build_sha: fullHash,
      files_committed: filesToStage.length,
    };
  } catch (err) {
    return { repo: repoName, ok: false, error: err.message, summary: err.stderr || err.message };
  }
}

export default function autoCommit(task, artifacts, projectConfig, currentRepo) {
  const worktreePaths = artifacts?.worktree_paths || {};
  const repos = currentRepo ? [currentRepo] : Object.keys(worktreePaths);

  if (repos.length === 0) {
    return { verdict: 'PASSED', summary: 'No worktrees to commit' };
  }

  const results = [];
  for (const repo of repos) {
    const wt = worktreePaths[repo];
    if (!wt) {
      return { verdict: 'FAILED', error: `No worktree path for ${repo}` };
    }
    results.push(commitOne(task, repo, wt, projectConfig));
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    return {
      verdict: 'FAILED',
      error: `Commit failed in: ${failed.map(f => f.repo).join(', ')}`,
      results,
    };
  }

  return {
    verdict: 'PASSED',
    summary: results.map(r => r.summary).join(' | '),
    results,
    // Convenience for downstream: a per-repo SHA map
    commit_hashes: Object.fromEntries(results.filter(r => r.commit_hash).map(r => [r.repo, r.commit_hash])),
  };
}
