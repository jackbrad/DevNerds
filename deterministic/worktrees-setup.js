/**
 * Setup Worktrees — Creates isolated git worktrees for each repo a task touches.
 *
 * Initial pass: uses task.repo_hints. If empty, skips (PLAN will populate later
 * via worktrees-setup-from-plan).
 *
 * Returns artifact: worktree_paths = { repoName: path }.
 */

import { createWorktreesForTask } from '../engine/worktree.js';

export default function setupWorktrees(task, artifacts, projectConfig) {
  const repos = Array.isArray(task.repo_hints) ? task.repo_hints : [];

  if (repos.length === 0) {
    return {
      verdict: 'PASSED',
      summary: 'No repo_hints — deferring worktree creation to post-plan setup',
      worktree_paths: {},
      repos: [],
    };
  }

  try {
    const worktreePaths = createWorktreesForTask(task.id, repos, projectConfig);
    return {
      verdict: 'PASSED',
      summary: `Created ${repos.length} worktree(s): ${repos.join(', ')}`,
      worktree_paths: worktreePaths,
      repos,
    };
  } catch (err) {
    return {
      verdict: 'FAILED',
      error: `Failed to create worktrees: ${err.message}`,
      summary: err.stderr || err.message,
    };
  }
}
