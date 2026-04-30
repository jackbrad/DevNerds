/**
 * Run a single task through the multi-repo pipeline.
 *
 * Usage: node engine/run-single-task.js <taskId> [configPath]
 *
 * configPath defaults to engine/config.js's DEFAULT_CONFIG_PATH
 * (config/devnerds.config.json, overridable via DEVNERDS_CONFIG_PATH).
 */

import { getTask } from './task-db.js';
import { executeBlueprint } from './blueprint-engine.js';
import { loadConfig } from './config.js';

export async function runTask(taskId, _blueprintOverride, configPath, options = {}) {
  const config = await loadConfig(configPath);

  let task = await getTask(taskId, config);
  if (!task) throw new Error(`Task ${taskId} not found in ${config.task_table}`);

  applyDomainHints(task, config);

  const { default: pipeline } = await import('../blueprints/pipeline.js');
  console.log(`Pipeline: ${pipeline.name} | repo_hints: ${(task.repo_hints || []).join(', ') || '(let PLAN decide)'}`);
  if (options.resumeFrom) console.log(`Resuming from node: ${options.resumeFrom}`);
  console.log(`\nExecuting pipeline for ${taskId}...\n`);

  return executeBlueprint(task, pipeline, config, options);
}

async function main() {
  const args = process.argv.slice(2);
  const taskId = args[0];
  // Allow either `<taskId> <config.json>` or `<taskId> _ <config.json>` shapes.
  const configPath = (args[1]?.includes('/') || args[1]?.endsWith('.json')) ? args[1] : args[2];

  if (!taskId) {
    console.error('Usage: node engine/run-single-task.js <taskId> [configPath]');
    process.exit(1);
  }

  const startTime = Date.now();
  const result = await runTask(taskId, null, configPath);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Task: ${taskId}`);
  console.log(`Verdict: ${result.finalVerdict}`);
  console.log(`Duration: ${result.totalDuration_s?.toFixed(1) || ((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`Completed nodes: ${(result.completedNodes || []).join(' → ')}`);
  if (result.failedNode) console.log(`Failed at: ${result.failedNode} — ${result.failureReason}`);
  console.log(`Artifacts: ./artifacts/${taskId}/`);
  console.log('='.repeat(60));
}

/**
 * Apply domain hints multi-repo style:
 * - If task already has repo_hints, leave them.
 * - Otherwise, scan every project's per-project domain map for keyword matches
 *   and pre-populate repo_hints with the matching repos. PLAN can still expand.
 */
export function applyDomainHints(task, config) {
  if (Array.isArray(task.repo_hints) && task.repo_hints.length > 0) return task;

  const matched = matchDomainSimple(task, config);
  if (matched.repos.length > 0) {
    task.repo_hints = matched.repos;
    task.files_hint = task.files_hint || matched.files_hint;
    task.domain = task.domain || matched.domain;
  }
  return task;
}

function matchDomainSimple(task, config) {
  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();
  const repos = new Set();
  let domain = 'unknown';
  const files_hint = [];

  for (const [repoName, project] of Object.entries(config.projects || {})) {
    const domains = project.domains || {};
    for (const [domainName, dconf] of Object.entries(domains)) {
      const keywords = dconf.keywords || [];
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          repos.add(repoName);
          if (domain === 'unknown') domain = domainName;
          for (const fh of (dconf.files_hint || [])) files_hint.push(fh);
          break;
        }
      }
    }
  }

  return { repos: [...repos], domain, files_hint };
}

const isMain = process.argv[1]?.endsWith('run-single-task.js');
if (isMain) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
