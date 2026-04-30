/**
 * Augment worktrees with any repos PLAN added beyond the initial repo_hints.
 *
 * PLAN's `build_order` is the source of truth for which repos are touched.
 * This step creates worktrees for any build_order repo that doesn't already
 * have one, and writes the canonical worktree_paths + build_order artifacts.
 */

import { createWorktreesForTask } from '../engine/worktree.js';
import fs from 'fs/promises';

export default async function setupWorktreesFromPlan(task, artifacts, projectConfig) {
  // Read plan output
  let plan = null;
  try {
    const planPath = artifacts?.plan_output;
    if (planPath) {
      const raw = await fs.readFile(planPath, 'utf-8');
      plan = JSON.parse(raw);
    }
  } catch (err) {
    return { verdict: 'FAILED', error: `Could not read plan output: ${err.message}` };
  }

  if (!plan) {
    return { verdict: 'FAILED', error: 'Could not read plan output' };
  }
  if (!Array.isArray(plan.build_order) || plan.build_order.length === 0) {
    const passed = plan.verdict === 'PASSED' || plan.verdict === 'PASS';
    if (!passed) {
      return { verdict: 'FAILED', error: 'PLAN produced no build_order and did not report PASSED' };
    }
    return {
      verdict: 'PASSED',
      summary: 'PLAN says no work needed — feature already implemented',
      build_order: [],
      plans: {},
      worktree_paths: artifacts?.worktree_paths || {},
    };
  }

  // Validate build_order against config
  const known = Object.keys(projectConfig.projects || {});
  const unknown = plan.build_order.filter(r => !known.includes(r));
  if (unknown.length) {
    return { verdict: 'FAILED', error: `PLAN build_order references unknown repos: ${unknown.join(', ')}` };
  }

  const existing = artifacts?.worktree_paths || {};
  const missing = plan.build_order.filter(r => !existing[r]);

  let added = {};
  if (missing.length > 0) {
    try {
      added = createWorktreesForTask(task.id, missing, projectConfig);
    } catch (err) {
      return { verdict: 'FAILED', error: `Failed to create worktrees: ${err.message}` };
    }
  }

  const worktree_paths = { ...existing, ...added };

  return {
    verdict: 'PASSED',
    summary: `Worktrees ready for ${plan.build_order.length} repo(s); added ${missing.length}`,
    worktree_paths,
    build_order: plan.build_order,
    plans: plan.plans || {},
  };
}
