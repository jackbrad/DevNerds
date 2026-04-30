/**
 * Cleanup Worktrees — Remove all worktrees created for this task.
 *
 * Called both on success (after atomic push) and on failure.
 * Does NOT push anything — atomic-push.js handles that.
 */

// Worktrees are intentionally preserved on failure so the human-in-the-loop
// terminal can `claude --resume <lastSessionId>` from the same cwd. The next
// `/run/<taskId>` invocation re-uses or replaces them via worktrees-setup.

export default function cleanupWorktree(task, artifacts /*, projectConfig */) {
  const worktreePaths = artifacts?.worktree_paths || {};
  const repos = Object.keys(worktreePaths);
  return {
    verdict: 'PASSED',
    summary: repos.length > 0
      ? `Worktrees preserved for human resume: ${repos.join(', ')}`
      : 'No worktrees to preserve',
  };
}
