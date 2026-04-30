/**
 * Step Prompt Composer — Multi-repo aware.
 *
 * Composes from:
 * 1. Step skeleton
 * 2. Task-specific blocks
 * 3. Per-step injections:
 *    - PLAN: list of available projects + repo_paths so it knows what's on disk
 *    - BUILD: only the slice for the currentRepo
 *    - EVALUATE: full plans map + worktree_paths
 * 4. Artifacts from prior steps
 * 5. Task data
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function composeStepPrompt(stepName, task, artifacts, projectConfig, currentRepo = null) {
  const parts = [];

  // 1. Skeleton
  const skeleton = await loadFile(path.join(__dirname, 'skeletons', `${stepName}.md`));
  parts.push(skeleton);

  // 2. Task-specific blocks
  const blocks = selectBlocks(stepName, task);
  for (const blockName of blocks) {
    try {
      const block = await loadFile(path.join(__dirname, 'blocks', `${blockName}.md`));
      parts.push(`\n## ${blockName.toUpperCase()} GUIDANCE\n${block}`);
    } catch { /* missing block — skip */ }
  }

  // 3. Per-step injections
  const planObj = await loadPlanArtifact(artifacts);
  const worktreePaths = artifacts?.worktree_paths || {};

  if (stepName === 'PLAN') {
    parts.push(formatAvailableProjects(projectConfig));
  }

  if (stepName === 'BUILD') {
    if (!currentRepo) {
      throw new Error('BUILD composer requires currentRepo');
    }
    const slice = planObj?.plans?.[currentRepo] || '(no slice found in plan; follow the task description)';
    const wt = worktreePaths[currentRepo] || '(unknown)';
    parts.push(`\n## YOUR REPO\n${currentRepo}\nworktree: ${wt}\n\n## YOUR PLAN SLICE\n${slice}`);
  }

  if (stepName === 'EVALUATE') {
    parts.push(formatEvaluateContext(planObj, worktreePaths));
  }

  // 4. Artifacts (skip the bulky plan_output for BUILD — slice already injected)
  if (artifacts && Object.keys(artifacts).length > 0) {
    parts.push('\n## ARTIFACTS FROM PRIOR STEPS');
    for (const [name, value] of Object.entries(artifacts)) {
      // Skip non-file artifacts (worktree_paths is a map, not a file path)
      if (typeof value !== 'string') continue;
      // BUILD: don't dump the whole plan again — slice already shown
      if (stepName === 'BUILD' && name === 'plan_output') continue;
      try {
        const content = await loadFile(value);
        parts.push(`\n### ${name}\n${content}`);
      } catch {
        parts.push(`\n### ${name}\n(artifact not found: ${value})`);
      }
    }
  }

  // 5. Scope guard for BUILD/FIX_CI
  if (stepName === 'BUILD' || stepName === 'FIX_CI') {
    parts.push(`\n## SCOPE CONSTRAINT — READ THIS FIRST
You may ONLY modify files in your assigned repo (${currentRepo || 'see slice'}). The cwd IS that repo.
If you discover a bug or issue OUTSIDE your slice:
1. Write a one-line note to /tmp/${task.id}-scope-notes.txt
2. DO NOT fix it. DO NOT modify that file.
3. Continue with your assigned slice only.
Modifying out-of-slice files breaks other repos and the cross-repo contracts. Hard rule.`);
  }

  // 6. Task data
  parts.push(formatTaskData(stepName, task, currentRepo));

  return parts.join('\n\n');
}

function formatAvailableProjects(projectConfig) {
  const projects = projectConfig.projects || {};
  const lines = ['\n## AVAILABLE PROJECTS', 'You may Read files via these absolute paths. Use Bash (`ls`, `cat`) to inspect any project.'];
  for (const [name, p] of Object.entries(projects)) {
    lines.push(`- ${name}  →  ${p.repo_path}  (env_type: ${p.env_type})`);
  }
  lines.push('\nBuild order rule: shared/infra repos first, then dependents (alphabetical), unless your explicit build_order overrides with justification.');
  return lines.join('\n');
}

function formatEvaluateContext(planObj, worktreePaths) {
  const lines = ['\n## WORKTREES TO REVIEW'];
  for (const [repo, wt] of Object.entries(worktreePaths)) {
    lines.push(`- ${repo}  →  ${wt}`);
  }
  if (planObj) {
    lines.push('\n## BUILD ORDER (from plan)');
    lines.push((planObj.build_order || []).join(' → '));
    lines.push('\n## PER-REPO PLAN SLICES (what BUILD agents were told to do)');
    for (const [repo, slice] of Object.entries(planObj.plans || {})) {
      lines.push(`\n### ${repo}\n${slice}`);
    }
    if (planObj.risks?.length) {
      lines.push('\n## PLAN-FLAGGED RISKS');
      for (const r of planObj.risks) lines.push(`- ${r}`);
    }
  }
  return lines.join('\n');
}

async function loadPlanArtifact(artifacts) {
  if (!artifacts?.plan_output) return null;
  try {
    const raw = await fs.readFile(artifacts.plan_output, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function selectBlocks(stepName, task) {
  const blocks = [];

  if (task.category === 'bugfix' || task.title?.toLowerCase().includes('fix') || task.title?.toLowerCase().includes('bug')) {
    blocks.push('bugfix');
  } else if (task.category === 'feature' || task.title?.toLowerCase().includes('add') || task.title?.toLowerCase().includes('implement')) {
    blocks.push('feature');
  }

  const agentType = task.agentType || 'frontend';
  if (agentType === 'frontend' || task.category === 'frontend') {
    blocks.push('frontend-visual');
  }

  if (task.id?.startsWith('GRM-') || task.source === 'gremlin') blocks.push('regression');
  if (task.failCount > 0) blocks.push('previously-failed');
  if (task.cross_domain || (task.repo_hints && task.repo_hints.length > 1)) blocks.push('cross-domain');
  if (task.title?.toLowerCase().includes('auth') || task.title?.toLowerCase().includes('security') ||
      task.title?.toLowerCase().includes('permission') || task.title?.toLowerCase().includes('cors')) {
    blocks.push('security');
  }

  return blocks.slice(0, 3);
}

function formatTaskData(stepName, task, currentRepo) {
  const acceptance = Array.isArray(task.acceptance) && task.acceptance.length > 0
    ? task.acceptance.map((a, i) => `  ${i + 1}. ${typeof a === 'string' ? a : a.S || JSON.stringify(a)}`).join('\n')
    : '  (none specified — extract from description)';

  let data = `
## TASK
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}
Category: ${task.category}
Priority: ${task.priority || 'unknown'}
Repo Hints: ${(task.repo_hints || []).join(', ') || '(none)'}
${currentRepo ? `Current Repo: ${currentRepo}` : ''}

## ACCEPTANCE CRITERIA
${acceptance}
`;

  if (task.failCount > 0 && task.failureHistory) {
    data += `
## PREVIOUS FAILURES (${task.failCount} attempts)
${task.failureHistory.map(f => `- ${f.node}: ${f.reason}`).join('\n')}
DO NOT repeat these approaches.
`;
  }

  return data;
}

async function loadFile(filePath) {
  return fs.readFile(filePath, 'utf-8');
}
