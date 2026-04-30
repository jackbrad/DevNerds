/**
 * Pipeline — Multi-repo DevNerds pipeline definition.
 *
 * Shape:
 *   validate-spec → worktrees-setup → baseline-check → plan (opus) →
 *   worktrees-setup-from-plan → per-repo cycle (build → lint → tests → commit) →
 *   evaluate → atomic-push → verify-push → DONE
 *
 * Per-repo cycle nodes have `for_each_repo: true` and run once per repo
 * in plan-decided build_order.
 */
export default {
  name: 'pipeline',
  description: 'DevNerds multi-repo pipeline: plan, build per repo, evaluate, atomic push',
  nodes: [
    {
      id: 'validate-spec',
      type: 'deterministic',
      action: 'validate-spec',
      on_success: 'worktrees-setup',
      on_failure: 'BLOCKED',
    },
    {
      id: 'worktrees-setup',
      type: 'deterministic',
      action: 'worktrees-setup',
      on_success: 'baseline-check',
      on_failure: 'FAILED',
    },
    {
      // Non-blocking infra check across whatever worktrees exist so far.
      id: 'baseline-check',
      type: 'deterministic',
      action: 'pre-flight',
      on_success: 'plan',
      on_failure: 'plan',
    },
    {
      // PLAN runs Opus: it must read across repos and produce per-repo slices.
      id: 'plan',
      type: 'agentic',
      step: 'PLAN',
      model: 'opus',
      timeout_ms: 900_000,
      max_turns: 80,
      max_budget_usd: 5,
      allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Agent'],
      on_success: 'worktrees-setup-from-plan',
      on_failure: 'cleanup-on-failure',
    },
    {
      id: 'worktrees-setup-from-plan',
      type: 'deterministic',
      action: 'worktrees-setup-from-plan',
      on_success: 'build',
      on_failure: 'cleanup-on-failure',
    },
    {
      // BUILD: per repo, in build_order. Slice-only context, narrow tools.
      id: 'build',
      type: 'agentic',
      step: 'BUILD',
      model: 'sonnet',
      for_each_repo: true,
      timeout_ms: 600_000,
      max_turns: 75,
      max_budget_usd: 10,
      allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Agent'],
      on_success: 'lint-autofix',
      on_failure: 'cleanup-on-failure',
    },
    {
      id: 'lint-autofix',
      type: 'deterministic',
      action: 'lint-autofix',
      for_each_repo: true,
      on_success: 'run-tests',
      on_failure: 'run-tests',
    },
    {
      id: 'run-tests',
      type: 'deterministic',
      action: 'run-tests',
      for_each_repo: true,
      on_success: 'auto-commit',
      on_failure: 'cleanup-on-failure',
    },
    {
      id: 'auto-commit',
      type: 'deterministic',
      action: 'auto-commit',
      for_each_repo: true,
      on_success: 'evaluate',
      on_failure: 'cleanup-on-failure',
    },
    {
      // EVALUATE: single agentic pass across all repos. Read-only.
      id: 'evaluate',
      type: 'agentic',
      step: 'EVALUATE',
      model: 'sonnet',
      timeout_ms: 600_000,
      max_turns: 25,
      max_budget_usd: 5,
      allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Agent'],
      on_success: 'atomic-push',
      on_failure: 'cleanup-on-failure',
    },
    {
      // Atomic push gate: pushes all repos in build_order. Either everything
      // ships or (Phase 1) we tolerate partial state and document it.
      id: 'atomic-push',
      type: 'deterministic',
      action: 'atomic-push',
      on_success: 'verify-push',
      on_failure: 'cleanup-on-failure',
    },
    {
      id: 'verify-push',
      type: 'deterministic',
      action: 'deploy-verify',
      on_success: 'cleanup-on-success',
      on_failure: 'cleanup-on-failure',
    },
    {
      id: 'cleanup-on-success',
      type: 'deterministic',
      action: 'worktree-cleanup',
      on_success: 'DONE',
      on_failure: 'DONE',
    },
    {
      id: 'cleanup-on-failure',
      type: 'deterministic',
      action: 'worktree-cleanup',
      on_success: 'FAILED',
      on_failure: 'FAILED',
    },
  ],
};
