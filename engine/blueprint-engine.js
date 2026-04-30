/**
 * Blueprint Engine — The Core of DevNerds (multi-repo aware).
 *
 * Executes a blueprint (sequence of deterministic + agentic nodes) for a task.
 * Tracks completed nodes for resumability.
 * Writes artifacts and metrics per node.
 *
 * Multi-repo additions:
 * - Nodes flagged `for_each_repo: true` run once per repo in
 *   state.artifacts.build_order (set by worktrees-setup-from-plan).
 * - currentRepo is passed to deterministic actions and to composeStepPrompt.
 * - state.artifacts carries `worktree_paths`, `build_order`, `plans` maps.
 * - On engine startup we cleanupOrphanedBranches() across all configured repos.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { logMetric, getTaskMetrics } from './metrics.js';
import { updateTaskStatus, updateTaskField } from './task-db.js';
import { syncArtifact, syncMetrics, cleanupLocalArtifacts } from './artifact-sync.js';
import { composeStepPrompt } from '../steps/composer.js';
import { cleanupOrphanedBranches } from './worktree.js';

import { createWriteStream } from 'fs';

export const pipelineEvents = new EventEmitter();
pipelineEvents.setMaxListeners(50);

const STREAM_LOG = '/tmp/devnerds-stream.jsonl';
let streamWriter = null;
function getStreamWriter() {
  if (!streamWriter) {
    streamWriter = createWriteStream(STREAM_LOG, { flags: 'a' });
  }
  return streamWriter;
}

function emitEvent(type, data) {
  pipelineEvents.emit(type, data);
  try {
    getStreamWriter().write(JSON.stringify({ type, ...data }) + '\n');
  } catch { /* non-critical */ }
}

// One-time orphan cleanup per process — call from worker or top-level entry.
let _orphanCleanupDone = false;
export function ensureOrphanCleanup(projectConfig) {
  if (_orphanCleanupDone) return;
  _orphanCleanupDone = true;
  try { cleanupOrphanedBranches(projectConfig); } catch (err) {
    console.error(`[Engine] Orphan cleanup failed: ${err.message}`);
  }
}

export async function executeBlueprint(task, blueprint, projectConfig, options = {}) {
  ensureOrphanCleanup(projectConfig);

  const pipelineId = `pipe-${Date.now()}-${task.id}`;
  const artifactsDir = path.join(projectConfig.artifactsPath || './artifacts', task.id);
  await fs.mkdir(artifactsDir, { recursive: true });

  try {
    if (streamWriter) { streamWriter.end(); streamWriter = null; }
    const { writeFileSync } = await import('fs');
    writeFileSync(STREAM_LOG, '');
  } catch { /* non-critical */ }

  const statePath = path.join(artifactsDir, 'pipeline-state.json');
  let state = await loadState(statePath);

  if (options.resumeFrom) console.log(`Resuming ${task.id} from node: ${options.resumeFrom}`);

  const startTime = Date.now();
  let currentNodeIndex = 0;

  // Helper: persist a FAILED verdict to DDB before returning, so the task
  // doesn't get stuck IN_PROGRESS forever when the engine bails before
  // executing any node.
  async function bailFailed(failedNode, failureReason) {
    try {
      await updateTaskStatus(task.id, 'FAILED', projectConfig, { failedNode, failureReason });
    } catch (e) {
      console.error(`[Engine] Could not record FAILED status for ${task.id}: ${e.message}`);
    }
    return { success: false, finalVerdict: 'FAILED', failedNode, failureReason, error: failureReason };
  }

  if (options.resumeFrom) {
    currentNodeIndex = blueprint.nodes.findIndex(n => n.id === options.resumeFrom);
    if (currentNodeIndex === -1) {
      return bailFailed('engine-init', `Resume node "${options.resumeFrom}" not found in blueprint`);
    }
  } else if (state.nextNode) {
    const terminals = new Set(['DONE', 'FAILED', 'BLOCKED', 'TESTING', 'CLOSED']);
    if (terminals.has(state.nextNode)) {
      console.log(`Previous run ended at ${state.nextNode} — starting fresh`);
      state = { completedNodes: [], artifacts: {} };
    } else {
      currentNodeIndex = blueprint.nodes.findIndex(n => n.id === state.nextNode);
      if (currentNodeIndex === -1) {
        return bailFailed('engine-init', `Resume target "${state.nextNode}" not found in blueprint`);
      }
      console.log(`Auto-resuming ${task.id} from node: ${state.nextNode}`);
    }
  } else if (state.completedNodes?.length > 0) {
    const lastCompleted = state.completedNodes[state.completedNodes.length - 1];
    currentNodeIndex = blueprint.nodes.findIndex(n => n.id === lastCompleted) + 1;
    if (currentNodeIndex >= blueprint.nodes.length) {
      return { success: true, finalVerdict: 'ALREADY_COMPLETE', completedNodes: state.completedNodes };
    }
    console.log(`Auto-resuming ${task.id} from node: ${blueprint.nodes[currentNodeIndex].id} (fallback: array order)`);
  }

  for (let i = currentNodeIndex; i < blueprint.nodes.length; i++) {
    const node = blueprint.nodes[i];

    if (state.completedNodes?.includes(node.id)) {
      console.log(`  Skipping completed node: ${node.id}`);
      continue;
    }

    console.log(`  Executing node: ${node.id} (${node.type}${node.for_each_repo ? ', per-repo' : ''})`);
    emitEvent('node', { taskId: task.id, nodeId: node.id, status: 'running', timestamp: new Date().toISOString() });
    await updateTaskField(task.id, 'currentNode', node.id, projectConfig);
    await updateTaskField(task.id, 'currentBlueprint', blueprint.name, projectConfig);

    const nodeStart = Date.now();
    let nodeResult;

    try {
      if (node.for_each_repo) {
        nodeResult = await executeForEachRepoNode(node, task, state, projectConfig, artifactsDir);
      } else if (node.type === 'deterministic') {
        nodeResult = await executeDeterministicNode(node, task, state.artifacts, projectConfig);
      } else if (node.type === 'agentic') {
        nodeResult = await executeAgenticNode(node, task, state.artifacts, projectConfig, artifactsDir);
      } else if (node.type === 'human-gate') {
        nodeResult = await executeHumanGate(task, state.artifacts, projectConfig);
      } else {
        throw new Error(`Unknown node type: ${node.type}`);
      }
    } catch (err) {
      nodeResult = { verdict: 'FAILED', error: err.message, stack: err.stack };
    } finally {
      // Always clear per-iteration repo marker once the parent node finishes.
      // Write '' rather than null — DynamoDB DocumentClient rejects bare null,
      // and lambda's taskFromDynamo already coalesces with `|| ''`.
      if (state.currentRepo) {
        state.currentRepo = null;
        // Pass null so updateTaskField REMOVEs the attribute — keeps in-memory
        // state and DDB consistent (was writing '' here).
        try { await updateTaskField(task.id, 'currentRepo', null, projectConfig); } catch {}
      }
    }

    const nodeDuration = (Date.now() - nodeStart) / 1000;
    const nodeStatus = (nodeResult.verdict === 'PASSED' || nodeResult.verdict === 'PASS' || nodeResult.verdict === 'FIXED') ? 'passed' : 'failed';
    emitEvent('node', { taskId: task.id, nodeId: node.id, status: nodeStatus, duration: nodeDuration, cost: nodeResult.cost_usd || 0, verdict: nodeResult.verdict, timestamp: new Date().toISOString() });

    await logMetric({
      pipelineId,
      taskId: task.id,
      blueprint: blueprint.name,
      node: node.id,
      nodeType: node.type,
      duration_s: nodeDuration,
      tokens_in: nodeResult.tokens_in || 0,
      tokens_out: nodeResult.tokens_out || 0,
      cost_usd: nodeResult.cost_usd || 0,
      verdict: nodeResult.verdict,
    });

    const nodeOutputContent = JSON.stringify(nodeResult, null, 2);
    const nodeArtifactPath = path.join(artifactsDir, `${node.id}_output.json`);
    await fs.writeFile(nodeArtifactPath, nodeOutputContent);
    await syncArtifact(task.id, `${node.id}_output.json`, nodeOutputContent);

    const taskMetrics = await getTaskMetrics(task.id);
    await syncMetrics(task.id, taskMetrics);

    if (!nodeResult.verdict) {
      console.log(`  WARNING: Node ${node.id} returned no verdict (subtype: ${nodeResult.subtype || 'unknown'}). Treating as FAILED.`);
      nodeResult.verdict = 'FAILED';
      nodeResult.error = nodeResult.error || `No verdict returned from ${node.id} (possible max_turns or permission issue)`;
    }

    if (nodeResult.verdict === 'PASSED' || nodeResult.verdict === 'PASS' ||
        nodeResult.verdict === 'SHIPPED' || nodeResult.verdict === 'FIXED') {
      if (nodeResult.session_id) state.lastAgentSessionId = nodeResult.session_id;
      state.completedNodes = state.completedNodes || [];
      state.completedNodes.push(node.id);
      // Forward progress invalidates any prior failure: clear stale fields so
      // the human-in-the-loop briefing doesn't act on data that no longer applies.
      // Exception: cleanup-on-failure is a bridge node that always lands in a
      // terminal failure state (its on_success is 'FAILED'). Clearing here
      // would erase the original failure context that the FAILED status needs.
      const nextOnSuccess = node.on_success;
      const isTerminalNext =
        nextOnSuccess === 'FAILED' || nextOnSuccess === 'BLOCKED' ||
        nextOnSuccess === 'AWAITING_REVIEW' || nextOnSuccess === 'NEEDS_ATTENTION';
      if (!isTerminalNext && (state.failedNode || state.failureReason)) {
        state.failedNode = null;
        state.failureReason = null;
        try {
          await updateTaskField(task.id, 'failedNode', null, projectConfig);
          await updateTaskField(task.id, 'failureReason', null, projectConfig);
        } catch (e) {
          console.warn(`[Engine] Could not clear stale failure fields on ${task.id}: ${e.message}`);
        }
      }

      state.artifacts = state.artifacts || {};
      state.artifacts[`${node.id}_output`] = path.join(artifactsDir, `${node.id}_output.json`);

      if (nodeResult.artifacts_written) {
        for (const artName of nodeResult.artifacts_written) {
          state.artifacts[artName] = path.join(artifactsDir, artName);
        }
      }

      // Multi-repo: hoist worktree_paths, build_order, plans into artifacts
      if (nodeResult.worktree_paths) state.artifacts.worktree_paths = nodeResult.worktree_paths;
      if (nodeResult.build_order)    state.artifacts.build_order    = nodeResult.build_order;
      if (nodeResult.plans)          state.artifacts.plans          = nodeResult.plans;

      const nextNodeId = node.on_success;
      if (nextNodeId === 'DONE' || nextNodeId === 'TESTING' || nextNodeId === 'CLOSED') {
        state.nextNode = null;
        await saveState(statePath, state, task.id, projectConfig);
        const totalDuration = (Date.now() - startTime) / 1000;
        await updateTaskStatus(task.id, nextNodeId === 'CLOSED' ? 'CLOSED' : 'DONE', projectConfig);
        await cleanupLocalArtifacts(artifactsDir);
        return { success: true, finalVerdict: nextNodeId, completedNodes: state.completedNodes, pipelineId, totalDuration_s: totalDuration };
      }

      if (nextNodeId === 'FAILED' || nextNodeId === 'BLOCKED' || nextNodeId === 'AWAITING_REVIEW' || nextNodeId === 'NEEDS_ATTENTION') {
        state.nextNode = null;
        await saveState(statePath, state, task.id, projectConfig);
        const totalDuration = (Date.now() - startTime) / 1000;
        const failureReason = state.failureReason || `Pipeline routed to ${nextNodeId} after ${node.id}`;
        await updateTaskStatus(task.id, nextNodeId, projectConfig, {
          failedNode: state.failedNode || node.id,
          failureReason,
        });
        await cleanupLocalArtifacts(artifactsDir);
        return {
          success: false, finalVerdict: nextNodeId,
          failedNode: state.failedNode || node.id,
          failureReason,
          completedNodes: state.completedNodes || [],
          pipelineId, totalDuration_s: totalDuration,
        };
      }

      state.nextNode = nextNodeId || blueprint.nodes[i + 1]?.id || null;
      await saveState(statePath, state, task.id, projectConfig);

      if (nextNodeId) {
        const jumpIndex = blueprint.nodes.findIndex(n => n.id === nextNodeId);
        if (jumpIndex !== -1 && jumpIndex !== i + 1) i = jumpIndex - 1;
      }
    } else if (nodeResult.verdict === 'NEEDS_ATTENTION') {
      if (nodeResult.session_id) {
        // Agentic node sessions go to lastAgentSessionId — the human-in-the-loop
        // terminal must NOT resume them (their system prompts demand JSON-only
        // output, which breaks free-form fix conversations). lastSessionId is
        // owned by terminal.js for the human's own session continuity.
        await updateTaskField(task.id, 'lastAgentSessionId', nodeResult.session_id, projectConfig);
      }
      console.log(`  [NEEDS_ATTENTION] ${node.id}: ${nodeResult.summary || nodeResult.error || 'Needs human review'}`);
      emitEvent('log', { taskId: task.id, nodeId: node.id, line: `NEEDS_ATTENTION: ${(nodeResult.summary || '').slice(0, 200)}`, timestamp: new Date().toISOString() });

      const cleanupNode = blueprint.nodes.find(n => n.id === 'cleanup-on-failure');
      if (cleanupNode) {
        try { await executeDeterministicNode(cleanupNode, task, state.artifacts, projectConfig); } catch {}
      }

      const totalDuration = (Date.now() - startTime) / 1000;
      await updateTaskStatus(task.id, 'NEEDS_ATTENTION', projectConfig, {
        failedNode: node.id,
        failureReason: nodeResult.summary || nodeResult.error || 'Plan flagged for human review',
      });
      await cleanupLocalArtifacts(artifactsDir);

      return {
        success: false,
        finalVerdict: 'NEEDS_ATTENTION',
        failedNode: node.id,
        failureReason: nodeResult.summary || 'Needs human review',
        completedNodes: state.completedNodes || [],
        pipelineId, totalDuration_s: totalDuration,
      };
    } else if (nodeResult.verdict === 'FAILED' || nodeResult.verdict === 'FAIL' ||
               nodeResult.verdict === 'REJECTED' || nodeResult.verdict === 'TIMEOUT') {
      if (nodeResult.session_id) {
        // See comment above — agentic sessions stay separate from terminal.
        state.lastAgentSessionId = nodeResult.session_id;
        await updateTaskField(task.id, 'lastAgentSessionId', nodeResult.session_id, projectConfig);
      }

      // keepNode: true — partial failure (e.g. atomic-push: some repos pushed,
      // some didn't). Surface as NEEDS_ATTENTION so the inbox flags it for
      // human review, but preserve state.nextNode so /restart/:taskId/:nodeId
      // resumes here without routing through cleanup-on-failure.
      if (nodeResult.keepNode) {
        const failureReason = nodeResult.failureReason || nodeResult.error || nodeResult.summary || 'Partial failure';
        state.failedNode = node.id;
        state.failureReason = failureReason;
        state.nextNode = node.id; // restart resumes here
        await saveState(statePath, state, task.id, projectConfig);
        const totalDuration = (Date.now() - startTime) / 1000;
        await updateTaskStatus(task.id, 'NEEDS_ATTENTION', projectConfig, {
          failedNode: node.id,
          failureReason,
        });
        return {
          success: false,
          finalVerdict: 'PARTIAL_FAILURE',
          failedNode: node.id,
          failureReason,
          keepNode: true,
          completedNodes: state.completedNodes || [],
          pipelineId, totalDuration_s: totalDuration,
        };
      }

      const failPath = node.on_failure;

      if (failPath === 'BLOCKED') {
          state.failedNode = node.id;
          state.failureReason = nodeResult.error || nodeResult.summary || 'Task blocked';
          await saveState(statePath, state, task.id, projectConfig);
          const totalDuration = (Date.now() - startTime) / 1000;
          await updateTaskStatus(task.id, 'BLOCKED', projectConfig, { failedNode: node.id, failureReason: state.failureReason });
          await cleanupLocalArtifacts(artifactsDir);
          return { success: false, finalVerdict: 'BLOCKED', failedNode: node.id, failureReason: state.failureReason, completedNodes: state.completedNodes || [], pipelineId, totalDuration_s: totalDuration };
      }

      if (failPath && failPath !== 'FAILED') {
        const jumpIndex = blueprint.nodes.findIndex(n => n.id === failPath);
        if (jumpIndex !== -1) {
          console.log(`  Node ${node.id} failed, routing to ${failPath}`);
          // Always reflect THIS failure — the OR-pattern used to preserve a
          // stale failedNode from an earlier-recovered failure, which leaked
          // misleading context downstream.
          state.failedNode = node.id;
          state.failureReason = nodeResult.error || nodeResult.notes || nodeResult.summary || 'Unknown failure';
          state.nextNode = failPath;
          await saveState(statePath, state, task.id, projectConfig);
          i = jumpIndex - 1;
          continue;
        }
      }

      // Evaluate retry: replay from validate-spec
      const MAX_EVALUATE_RETRIES = 2;
      if (node.step === 'EVALUATE') {
        state.evaluateRetries = (state.evaluateRetries || 0) + 1;
        const feedback = nodeResult.error || nodeResult.notes || nodeResult.summary || 'Evaluate rejected — no details';

        task.failCount = state.evaluateRetries;
        task.failureHistory = task.failureHistory || [];
        task.failureHistory.push({ node: 'evaluate', reason: feedback, attempt: state.evaluateRetries });

        await updateTaskField(task.id, 'failCount', state.evaluateRetries, projectConfig);
        await updateTaskField(task.id, 'failureHistory', task.failureHistory, projectConfig);

        const evalFeedbackPath = path.join(artifactsDir, 'evaluate_feedback.json');
        await fs.writeFile(evalFeedbackPath, JSON.stringify({ attempt: state.evaluateRetries, feedback, full: nodeResult }, null, 2));
        state.artifacts = state.artifacts || {};
        state.artifacts.evaluate_feedback = evalFeedbackPath;

        if (state.evaluateRetries < MAX_EVALUATE_RETRIES) {
          console.log(`  [RETRY] Evaluate rejected (attempt ${state.evaluateRetries}/${MAX_EVALUATE_RETRIES}) — retrying from plan`);
          emitEvent('log', { taskId: task.id, nodeId: 'evaluate', line: `RETRY ${state.evaluateRetries}/${MAX_EVALUATE_RETRIES}: ${feedback.slice(0, 200)}`, timestamp: new Date().toISOString() });

          const cleanupNode = blueprint.nodes.find(n => n.id === 'cleanup-on-failure');
          if (cleanupNode) {
            try { await executeDeterministicNode(cleanupNode, task, state.artifacts, projectConfig); } catch {}
          }

          // Restart at `plan` — the deterministic prep nodes before it
          // (validate-spec, worktrees-setup, baseline-check) don't need to
          // re-run; only the agentic plan/build/eval cycle does. Trim
          // completedNodes to entries that came before `plan` so they aren't
          // re-executed.
          const planIdx = blueprint.nodes.findIndex(n => n.id === 'plan');
          if (planIdx <= 0) {
            // Defensive fallback — shouldn't happen with the current pipeline
            state.completedNodes = [];
            state.nextNode = 'validate-spec';
            i = -1;
          } else {
            state.completedNodes = (state.completedNodes || []).filter(id => {
              const idx = blueprint.nodes.findIndex(n => n.id === id);
              return idx >= 0 && idx < planIdx;
            });
            state.nextNode = 'plan';
            i = planIdx - 1; // i++ at the loop header lands us on plan
          }
          await saveState(statePath, state, task.id, projectConfig);
          continue;
        } else {
          console.log(`  [MAX RETRIES] Evaluate rejected ${state.evaluateRetries} times — sending to AWAITING_REVIEW`);

          const cleanupNode = blueprint.nodes.find(n => n.id === 'cleanup-on-failure');
          if (cleanupNode) {
            try { await executeDeterministicNode(cleanupNode, task, state.artifacts, projectConfig); } catch {}
          }

          state.failedNode = node.id;
          state.failureReason = `Evaluate rejected ${state.evaluateRetries} times. Last: ${feedback}`;
          await saveState(statePath, state, task.id, projectConfig);

          const totalDuration = (Date.now() - startTime) / 1000;
          await updateTaskStatus(task.id, 'AWAITING_REVIEW', projectConfig, {
            failedNode: node.id,
            failureReason: state.failureReason,
          });
          await cleanupLocalArtifacts(artifactsDir);

          return {
            success: false,
            finalVerdict: 'AWAITING_REVIEW',
            failedNode: node.id,
            failureReason: state.failureReason,
            completedNodes: state.completedNodes || [],
            pipelineId, totalDuration_s: totalDuration,
          };
        }
      }

      state.failedNode = node.id;
      state.failureReason = nodeResult.error || nodeResult.notes || nodeResult.summary || 'Unknown failure';
      state.remediation = generateRemediation(node, nodeResult, state);
      await saveState(statePath, state, task.id, projectConfig);

      const totalDuration = (Date.now() - startTime) / 1000;
      await updateTaskStatus(task.id, 'FAILED', projectConfig, {
        failedNode: node.id,
        failureReason: state.failureReason,
        remediation: state.remediation,
      });
      await cleanupLocalArtifacts(artifactsDir);

      return {
        success: false,
        finalVerdict: 'FAILED',
        failedNode: node.id,
        failureReason: state.failureReason,
        completedNodes: state.completedNodes || [],
        pipelineId, totalDuration_s: totalDuration,
      };
    }
  }

  return { success: false, finalVerdict: 'FAILED', error: 'Blueprint completed without terminal state' };
}

/**
 * Run a node once per repo in build_order. Aggregate verdicts.
 * Per-repo deterministic actions receive currentRepo; agentic gets it via composer.
 * Emits per-iteration node/log events keyed by `${node.id}:${repo}` so the UI
 * can tell apart e.g. build:shared vs build:web.
 */
async function executeForEachRepoNode(node, task, state, projectConfig, artifactsDir) {
  const artifacts = state.artifacts || {};
  const buildOrder = artifacts.build_order || [];
  if (buildOrder.length === 0) {
    return { verdict: 'FAILED', error: `for_each_repo node ${node.id} has no build_order in artifacts` };
  }

  const perRepo = [];
  let aggCost = 0, aggIn = 0, aggOut = 0;

  for (const repo of buildOrder) {
    console.log(`    [${node.id}] repo: ${repo}`);

    state.currentRepo = repo;
    await updateTaskField(task.id, 'currentRepo', repo, projectConfig);

    const subNodeId = `${node.id}:${repo}`;
    const iterStart = Date.now();
    emitEvent('node', { taskId: task.id, nodeId: subNodeId, currentRepo: repo, status: 'running', timestamp: new Date().toISOString() });

    let result;
    try {
      if (node.type === 'deterministic') {
        const { default: handler } = await import(`../deterministic/${node.action}.js`);
        result = await handler(task, artifacts, projectConfig, repo);
      } else if (node.type === 'agentic') {
        result = await executeAgenticNode(node, task, artifacts, projectConfig, artifactsDir, repo);
      } else {
        throw new Error(`Unsupported node type for for_each_repo: ${node.type}`);
      }
    } catch (err) {
      result = { verdict: 'FAILED', error: err.message };
    }

    perRepo.push({ repo, result });
    aggCost += result.cost_usd || 0;
    aggIn   += result.tokens_in || 0;
    aggOut  += result.tokens_out || 0;

    const okVerdicts = new Set(['PASSED', 'PASS', 'SHIPPED', 'FIXED']);
    const iterPassed = okVerdicts.has(result.verdict);
    const iterDuration = (Date.now() - iterStart) / 1000;
    emitEvent('node', {
      taskId: task.id,
      nodeId: subNodeId,
      currentRepo: repo,
      status: iterPassed ? 'passed' : 'failed',
      duration: iterDuration,
      cost: result.cost_usd || 0,
      verdict: result.verdict,
      timestamp: new Date().toISOString(),
    });

    if (!iterPassed) {
      return {
        verdict: result.verdict || 'FAILED',
        error: `${node.id} failed in ${repo}: ${result.error || result.summary || 'no detail'}`,
        per_repo: perRepo,
        cost_usd: aggCost, tokens_in: aggIn, tokens_out: aggOut,
      };
    }
  }

  return {
    verdict: 'PASSED',
    summary: `${node.id} passed in ${perRepo.length} repo(s)`,
    per_repo: perRepo,
    cost_usd: aggCost, tokens_in: aggIn, tokens_out: aggOut,
  };
}

async function executeDeterministicNode(node, task, artifacts, projectConfig) {
  const { default: handler } = await import(`../deterministic/${node.action}.js`);
  return handler(task, artifacts, projectConfig);
}

async function executeAgenticNode(node, task, artifacts, projectConfig, artifactsDir, currentRepo = null) {
  const prompt = await composeStepPrompt(node.step, task, artifacts, projectConfig, currentRepo);

  const promptSuffix = currentRepo ? `_${currentRepo}` : '';
  const promptPath = path.join(artifactsDir, `${node.id}${promptSuffix}_prompt.md`);
  await fs.writeFile(promptPath, prompt);
  await syncArtifact(task.id, `${node.id}${promptSuffix}_prompt.md`, prompt);

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  args.push('--model', node.model || 'sonnet');
  if (node.max_budget_usd) args.push('--max-budget-usd', String(node.max_budget_usd));
  if (node.max_turns) args.push('--max-turns', String(node.max_turns));
  if (node.allowedTools) args.push('--allowedTools', node.allowedTools.join(','));
  if (node.isolation === 'worktree') args.push('--worktree', `${node.id}-${task.id}`);

  // Service context: prefer currentRepo's first domain context, fall back to task.domain
  const proj = currentRepo ? projectConfig.projects?.[currentRepo] : null;
  let serviceContext = '';
  if (proj?.domains) {
    const firstDomain = Object.values(proj.domains)[0];
    serviceContext = firstDomain?.context || '';
  }
  if (!serviceContext && task.domain) {
    // Last-ditch: scan all projects for that domain key
    for (const p of Object.values(projectConfig.projects || {})) {
      if (p.domains?.[task.domain]?.context) { serviceContext = p.domains[task.domain].context; break; }
    }
  }
  const agentType = (node.step === 'EVALUATE')
    ? 'test'
    : (task.agentType || task.persona || 'backend');
  if (serviceContext || agentType) {
    args.push('--append-system-prompt', `You are a ${agentType} engineer. ${serviceContext}`);
  }

  const timeoutMs = node.timeout_ms || 1_200_000;
  // cwd: currentRepo's worktree → that repo's repo_path → fallback first project
  let effectiveCwd;
  if (currentRepo && artifacts?.worktree_paths?.[currentRepo]) {
    effectiveCwd = artifacts.worktree_paths[currentRepo];
  } else if (currentRepo && proj) {
    effectiveCwd = proj.repo_path;
  } else {
    // PLAN/EVALUATE: any sane cwd works; pick the first worktree or any repo
    const wtPaths = artifacts?.worktree_paths || {};
    effectiveCwd = Object.values(wtPaths)[0]
      || Object.values(projectConfig.projects || {})[0]?.repo_path
      || process.cwd();
  }

  const result = await spawnClaudeCode(args, timeoutMs, effectiveCwd, task.id, node.id, currentRepo);

  const responseContent = JSON.stringify(result.raw, null, 2);
  const transcriptPath = path.join(artifactsDir, `${node.id}${promptSuffix}_response.json`);
  await fs.writeFile(transcriptPath, responseContent);
  await syncArtifact(task.id, `${node.id}${promptSuffix}_response.json`, responseContent);

  return parseAgentOutput(result, node.id, node.step);
}

async function executeHumanGate(task, artifacts, projectConfig) {
  await updateTaskStatus(task.id, 'AWAITING_REVIEW', projectConfig);
  console.log(`\n  HUMAN GATE: Task ${task.id} is waiting for review.`);
  console.log(`     Review artifacts in: artifacts/${task.id}/`);
  console.log(`     Approve: POST /tasks/${task.id}/approve  (or use the UI button)`);
  console.log(`     Reject:  POST /tasks/${task.id}/reject  with {"reason": "..."}\n`);

  const GATE_TIMEOUT_MS = 86_400_000;
  return new Promise((resolve) => {
    const gateStart = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - gateStart > GATE_TIMEOUT_MS) {
        clearInterval(interval);
        resolve({ verdict: 'FAILED', error: 'Human gate timed out after 24 hours' });
        return;
      }
      try {
        const { getTaskStatus } = await import('./task-db.js');
        const status = await getTaskStatus(task.id, projectConfig);
        if (status === 'IN_PROGRESS') {
          clearInterval(interval);
          resolve({ verdict: 'PASSED', notes: 'Human approved' });
        } else if (status === 'FAILED') {
          clearInterval(interval);
          resolve({ verdict: 'FAILED', notes: 'Human rejected' });
        }
      } catch (err) {
        console.error(`[Human Gate] Poll error for ${task.id}: ${err.message}`);
      }
    }, 10_000);
  });
}

function spawnClaudeCode(args, timeoutMs, cwd, taskId, nodeId, currentRepo = null) {
  const logEvent = (line) => {
    if (!taskId) return;
    const payload = { taskId, nodeId, line, timestamp: new Date().toISOString() };
    if (currentRepo) payload.currentRepo = currentRepo;
    emitEvent('log', payload);
  };
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    const proc = spawn(process.env.DEVNERDS_CLAUDE_PATH || 'claude', args, {
      cwd, env: childEnv, detached: true,
    });

    let stdoutBuffer = '';
    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                const preview = block.text.slice(0, 200);
                console.log(`  [${nodeId}] ${preview}`);
                logEvent(preview);
              } else if (block.type === 'tool_use') {
                const toolLine = `[tool] ${block.name}(${JSON.stringify(block.input || {}).slice(0, 100)})`;
                console.log(`  [${nodeId}] ${toolLine}`);
                logEvent(toolLine);
              }
            }
          } else if (msg.type === 'tool_result' || msg.type === 'user') {
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'tool_result') {
                  const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
                  const preview = output.slice(0, 150);
                  console.log(`  [${nodeId}]   → ${preview}`);
                  logEvent(`  → ${preview}`);
                }
              }
            }
          }
        } catch { /* incomplete JSON */ }
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // Snapshot pid into a const + track exited state. PIDs get recycled by the
    // kernel; if we wait, then signal -proc.pid we may SIGKILL an unrelated
    // process group on the box.
    const pid = proc.pid;
    let exited = false;
    let timeoutHandle = null;
    let killEscalation = null;

    proc.on('close', (code) => {
      exited = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      if (code === null) {
        resolve({ raw: { stdout, stderr, exitCode: 124 }, timedOut: true });
      } else {
        resolve({ raw: { stdout, stderr, exitCode: code }, timedOut: false });
      }
    });

    proc.on('error', (err) => reject(err));

    timeoutHandle = setTimeout(() => {
      if (exited) return;
      try {
        process.kill(-pid, 'SIGTERM');
        killEscalation = setTimeout(() => {
          if (exited) return;
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        }, 5_000);
        killEscalation.unref();
      } catch {}
    }, timeoutMs);
    timeoutHandle.unref();
  });
}

function parseAgentOutput(result, nodeId, stepType) {
  if (result.timedOut) {
    return { verdict: 'TIMEOUT', error: `Node ${nodeId} timed out`, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  }

  const { stdout, stderr, exitCode } = result.raw;

  let envelope = null;
  for (const line of stdout.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'result') { envelope = parsed; break; }
    } catch { continue; }
  }

  if (!envelope) {
    try { envelope = JSON.parse(stdout); } catch {}
  }

  try {
    if (!envelope) throw new Error('No result envelope found');

    const usage = envelope.usage || {};
    const tokensIn = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const tokensOut = usage.output_tokens || 0;
    const costUsd = envelope.total_cost_usd || 0;
    const meta = { tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, session_id: envelope.session_id, num_turns: envelope.num_turns };

    if (envelope.subtype === 'error_max_turns') {
      const denials = envelope.permission_denials || [];
      const denialSummary = denials.length ? ` (${denials.length} permission denials)` : '';
      const agentOutput = extractJsonFromText(envelope.result);
      if (agentOutput?.verdict) return { ...agentOutput, ...meta };
      return { verdict: 'FAILED', error: `Agent hit max turns${denialSummary}`, subtype: 'error_max_turns', ...meta };
    }

    let agentOutput;
    try {
      agentOutput = JSON.parse(envelope.result);
    } catch {
      agentOutput = extractJsonFromText(envelope.result);
    }

    if (!agentOutput?.verdict) {
      if (envelope.subtype === 'success' && stepType === 'BUILD') {
        console.log(`  [${nodeId}] Build completed successfully but no JSON verdict — defaulting to PASSED (evaluate will QA)`);
        return { verdict: 'PASSED', summary: envelope.result?.slice(0, 500) || 'Build completed', ...meta };
      }
      return { verdict: 'FAILED', error: `Agent produced no structured verdict (subtype: ${envelope.subtype})`, raw_result: (envelope.result || '').slice(0, 2000), ...meta };
    }

    return { ...agentOutput, ...meta };
  } catch {
    /* fall through */
  }

  const jsonFromText = extractJsonFromText(stdout);
  if (jsonFromText) return jsonFromText;

  const text = stdout + stderr;
  for (const keyword of ['PASSED', 'SHIPPED', 'FIXED', 'PASS', 'FAILED', 'FAIL', 'REJECTED', 'TIMEOUT']) {
    if (text.includes(`"verdict": "${keyword}"`) || text.includes(`"verdict":"${keyword}"`)) {
      return { verdict: keyword, summary: `Extracted verdict from text`, raw_output: text.slice(0, 2000) };
    }
  }

  if (stepType === 'BUILD' && exitCode === 0) {
    console.log(`  [${nodeId}] Build exited 0 but no parseable output — defaulting to PASSED (evaluate will QA)`);
    return { verdict: 'PASSED', summary: 'Build completed (no structured output)', cost_usd: 0 };
  }

  return {
    verdict: 'FAILED',
    error: `Could not parse output from node ${nodeId}`,
    exitCode,
    raw_stdout: stdout.slice(0, 2000),
    raw_stderr: stderr.slice(0, 2000),
  };
}

function extractJsonFromText(text) {
  if (!text) return null;
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1]); } catch {}
  }
  const jsonMatch = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  return null;
}

async function loadState(statePath) {
  try {
    const data = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { completedNodes: [], artifacts: {} };
  }
}

async function saveState(statePath, state, taskId, projectConfig) {
  const content = JSON.stringify(state, null, 2);
  await fs.writeFile(statePath, content);
  if (taskId) await syncArtifact(taskId, 'pipeline-state.json', content);
  if (taskId && projectConfig) {
    await updateTaskField(taskId, 'pipelineState', {
      completedNodes: state.completedNodes || [],
      failedNode: state.failedNode || null,
      failureReason: state.failureReason || null,
      remediation: state.remediation || null,
      lastAgentSessionId: state.lastAgentSessionId || null,
    }, projectConfig);
  }
}

function generateRemediation(node, nodeResult, state) {
  const reason = nodeResult.error || nodeResult.notes || nodeResult.summary || '';
  const lines = [];

  if (node.id === 'validate-spec') {
    lines.push('Task spec is incomplete or repo_hints invalid. Add missing fields or fix repo_hints and re-run.');
  } else if (node.id === 'build') {
    if (reason.includes('max turns')) {
      lines.push('Build ran out of turns. Slice may be too large for one BUILD step.');
      lines.push('Options: (1) Split into smaller tasks. (2) Increase max_turns in the blueprint. (3) Pre-do some work manually.');
    } else {
      lines.push('Build failed. Check build_*_response.json for the failing repo.');
    }
  } else if (node.id === 'run-tests') {
    lines.push(`Tests failed: ${nodeResult.summary || ''}`);
    lines.push('Check run-tests_output.json for the failing repo and test names.');
  } else if (node.id === 'evaluate') {
    lines.push('Evaluate rejected the changes. Reason:');
    lines.push(reason);
  } else if (node.id === 'atomic-push') {
    lines.push('Atomic push had failures — see results in atomic-push_output.json.');
    lines.push('Partial state is documented Phase 1 limitation. Inspect each repo manually.');
  } else if (node.id === 'verify-push') {
    lines.push('Deploy verification failed — push may not have landed yet.');
  }

  if (state.completedNodes?.length > 0) {
    lines.push(`Completed nodes: ${state.completedNodes.join(' → ')}`);
    lines.push(`To resume: node engine/run-single-task.js <taskId> config/devnerds.config.json`);
  }

  return lines.join('\n');
}
