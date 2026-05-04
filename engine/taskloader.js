/**
 * Task Loader — Validates tasks, triages with Haiku, deduplicates, enriches, queues work.
 *
 * Runs on cron (every 30 min) or manually: node engine/taskloader.js
 * Uses Claude Haiku for smart triage: domain matching, spec quality, decomposition.
 */

import { readFileSync } from 'fs';
import { getTasksByStatus, updateTaskStatus, updateTaskField, appendTaskNote } from './task-db.js';
import { loadConfig } from './config.js';
import { Queue } from 'bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { alertInfra, alertTaskLoaderSummary } from './notify.js';
import { validateTask } from './task-schema.js';

// Load .env if ANTHROPIC_API_KEY isn't already in the environment
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf-8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch { /* no .env file — rely on environment */ }
}

/**
 * Run the task loader: scan TODO tasks, validate, enrich, queue.
 */
export async function runTaskLoader(configPath) {
  const config = await loadConfig(configPath);
  const queue = new Queue('devnerds-tasks', { connection: { host: config.redis_host || 'localhost', port: config.redis_port || 6379 } });

  console.log(`[TaskLoader] Scanning for TODO tasks in ${config.task_table}...`);

  // Get all TODO tasks
  const todoTasks = await getTasksByStatus('TODO', config);
  console.log(`[TaskLoader] Found ${todoTasks.length} TODO tasks.`);

  // Get currently IN_PROGRESS tasks (for dedup)
  const inProgressTasks = await getTasksByStatus('IN_PROGRESS', config);
  const awaitingTasks = await getTasksByStatus('AWAITING_REVIEW', config);
  const openTasks = [...inProgressTasks, ...awaitingTasks];

  // Get task IDs already in the BullMQ queue (waiting or active) to prevent double-queuing
  const [waitingJobs, activeJobs] = await Promise.all([queue.getWaiting(), queue.getActive()]);
  const queuedTaskIds = new Set([...waitingJobs, ...activeJobs].map(j => j.data?.taskId).filter(Boolean));
  if (queuedTaskIds.size > 0) {
    console.log(`[TaskLoader] ${queuedTaskIds.size} task(s) already in queue — will skip.`);
  }

  // Get DONE tasks (for dependency checks)
  const doneTasks = await getTasksByStatus('DONE', config);
  const doneIds = new Set(doneTasks.map(t => t.id));

  let queued = 0;
  let blocked = 0;
  let skipped = 0;

  const errors = [];

  for (const task of todoTasks) {
    try {
    // 0. Skip if already in BullMQ queue
    if (queuedTaskIds.has(task.id)) {
      console.log(`  [SKIP] ${task.id}: Already in queue`);
      skipped++;
      continue;
    }

    // 1. Validate required fields (rules in engine/task-schema.js)
    const validation = validateTaskSpec(task, config);
    if (!validation.valid) {
      await updateTaskStatus(task.id, 'BLOCKED', config);
      await appendTaskNote(task.id, 'taskloader', `BLOCKED: ${validation.reason}`, config);
      console.log(`  [BLOCKED] ${task.id}: ${validation.reason}`);
      blocked++;
      continue;
    }

    // 2. Check for duplicates
    const duplicate = checkDuplicate(task, openTasks);
    if (duplicate) {
      await updateTaskStatus(task.id, 'BLOCKED', config);
      await appendTaskNote(task.id, 'taskloader', `BLOCKED: Possible duplicate of ${duplicate.id}`, config);
      console.log(`  [BLOCKED] ${task.id}: Possible duplicate of ${duplicate.id}`);
      blocked++;
      continue;
    }

    // 3. Check dependencies — skip if prerequisites not DONE yet
    if (Array.isArray(task.depends_on) && task.depends_on.length > 0) {
      const unmet = task.depends_on.filter(dep => !doneIds.has(dep));
      if (unmet.length > 0) {
        console.log(`  [WAITING] ${task.id}: Dependencies not done yet: ${unmet.join(', ')}`);
        skipped++;
        continue;
      }
    }

    // 4. LLM triage — domain, agent type, spec quality, decomposition
    const triage = await triageWithLLM(task, config);
    console.log(`  [TRIAGE] ${task.id}: domain=${triage.domain}, agentType=${triage.agentType} — ${triage.reasoning}`);

    // 5. Handle spec issues — only block if high risk (unlikely to complete)
    if (triage.specIssues.length > 0) {
      const issueList = triage.specIssues.join('; ');
      if (triage.specRisk === 'high') {
        await updateTaskStatus(task.id, 'BLOCKED', config);
        await appendTaskNote(task.id, 'taskloader', `BLOCKED (unlikely to complete): ${issueList}`, config);
        console.log(`  [BLOCKED] ${task.id}: High-risk spec — ${issueList}`);
        blocked++;
        continue;
      }
      // Medium/low — log the warning but keep going
      await appendTaskNote(task.id, 'taskloader', `Spec warnings (${triage.specRisk}): ${issueList}`, config);
      console.log(`  [WARN] ${task.id}: Spec issues (${triage.specRisk}) — ${issueList}`);
    }

    // 6. Enrich task with triage context
    // Preserve any explicit repo_hints on the task; only fall back to triage
    // when the human author didn't pin them. PLAN can still expand later.
    const repoHints = (Array.isArray(task.repo_hints) && task.repo_hints.length > 0)
      ? task.repo_hints
      : triage.repo_hints || [];
    const enrichedPayload = {
      taskId: task.id,
      task: {
        ...task,
        domain: triage.domain,
        agentType: triage.agentType,
        files_hint: triage.files_hint,
        repo_hints: repoHints,
      },
      blueprint: 'pipeline',
      domain: triage.domain,
    };

    // 8. Queue with priority
    const priority = priorityToNumber(task.priority);
    await queue.add('process-task', enrichedPayload, { priority });

    // 9. Update metadata (keep as TODO — worker sets IN_PROGRESS when it actually starts)
    await updateTaskField(task.id, 'assignee', triage.agentType, config);
    await updateTaskField(task.id, 'domain', triage.domain, config);
    await updateTaskField(task.id, 'blueprint', 'pipeline', config);
    if (repoHints.length > 0) await updateTaskField(task.id, 'repo_hints', repoHints, config);
    await appendTaskNote(task.id, 'taskloader', `Queued: agentType=${triage.agentType}, domain=${triage.domain}, repos=[${repoHints.join(', ')}]. Triage: ${triage.reasoning}`, config);

    console.log(`  [QUEUED] ${task.id} → agentType=${triage.agentType}, domain=${triage.domain}`);
    queued++;
    } catch (err) {
      console.error(`  [ERROR] ${task.id}: ${err.message}`);
      errors.push(`${task.id}: ${err.message}`);
    }
  }

  console.log(`[TaskLoader] Done. Queued: ${queued}, Blocked: ${blocked}, Skipped: ${skipped}, Errors: ${errors.length}`);
  await alertTaskLoaderSummary(queued, blocked, errors);
  await queue.close();
}

/**
 * Validate task spec via the shared schema. Caller wants {valid, reason} so
 * we collapse multi-error output into the first error.
 */
function validateTaskSpec(task, config) {
  const knownProjects = Object.keys(config?.projects || {});
  const { valid, errors } = validateTask(task, { knownProjects });
  if (valid) return { valid: true };
  return { valid: false, reason: errors[0] };
}

/**
 * Check for duplicate tasks against open tasks.
 * Layer 1: Exact title match.
 * Layer 2: Same domain + overlapping files_hint.
 */
function checkDuplicate(task, openTasks) {
  for (const open of openTasks) {
    // Exact title match
    if (task.title === open.title) return open;

    // Same domain + high title similarity (simple word overlap)
    if (task.domain && open.domain && task.domain === open.domain) {
      const similarity = wordOverlap(task.title, open.title);
      if (similarity > 0.7) return open;
    }
  }
  return null;
}

/**
 * Simple word overlap similarity (0-1).
 */
function wordOverlap(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Aggregate `projects.*.domains.*` into a flat domain map keyed by domain name.
 * Each entry carries the merged dconf plus the list of repos it belongs to,
 * so triage can decide both `domain` and `repo_hints` from one match.
 */
function buildDomainMap(config) {
  // Legacy single-repo `domain_map` still wins if present.
  if (config.domain_map && Object.keys(config.domain_map).length > 0) {
    return config.domain_map;
  }
  const out = {};
  for (const [repoName, project] of Object.entries(config.projects || {})) {
    for (const [domainName, dconf] of Object.entries(project.domains || {})) {
      if (!out[domainName]) {
        out[domainName] = { ...dconf, repos: [repoName] };
      } else {
        out[domainName].repos.push(repoName);
      }
    }
  }
  return out;
}

/**
 * Triage a task using Claude Haiku — domain matching, spec quality, decomposition.
 * Returns: { domain, agentType, files_hint, repo_hints, specIssues, shouldSplit, splitSuggestion, reasoning }
 * Falls back to deterministic logic if the API call fails.
 */
async function triageWithLLM(task, config) {
  const domainMap = buildDomainMap(config);

  // Build a compact domain reference for the prompt
  const domainRef = Object.entries(domainMap).map(([name, d]) => (
    `- ${name}: ${d.context || ''} (repos: ${(d.repos || []).join(', ') || 'n/a'}, files: ${(d.files_hint || []).join(', ')})`
  )).join('\n');

  const prompt = `You are a task triage agent for a software project. Analyze this task and return a JSON decision.

## Task
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}
Category: ${task.category || 'unknown'}
Priority: ${task.priority || 'unknown'}
Acceptance Criteria: ${JSON.stringify(task.acceptance || [])}

## Available Domains
${domainRef}

## Your Job
Return ONLY a JSON object (no markdown fences, no explanation) with these fields:

{
  "domain": "the best-matching domain name from the list above, or 'unknown'",
  "spec_issues": ["list of problems with the spec, empty array if spec is good"],
  "spec_risk": "low | medium | high",
  "reasoning": "1-2 sentences explaining your domain choice"
}

Guidelines:
- Pick the domain whose context best matches the INTENT of the task, not just keyword overlap. A task about "login page is slow" is auth, not styles.
- Flag spec issues like: vague acceptance criteria, contradictory requirements, missing context that would cause the builder to guess.
- spec_risk: "low" = minor nits, will probably succeed. "medium" = some ambiguity, might go off-track. "high" = the builder will almost certainly fail or go wildly out of scope — missing critical info, contradictory requirements, no clear success criteria.
- Only use "high" when the task is unlikely to complete successfully. Most tasks with minor issues should be "medium" or "low".
- Do NOT recommend splitting tasks. The builder agent handles decomposition at build time.`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = response.content[0]?.text || '';
    // Strip markdown fences if Haiku wraps the JSON
    text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const triage = JSON.parse(text);

    // Resolve domain → agentType + files_hint + repo_hints from config
    const domainConfig = domainMap[triage.domain] || {};
    const agentType = domainConfig.agentType || domainConfig.persona || (task.category === 'frontend' ? 'frontend' : 'backend');

    return {
      domain: triage.domain || 'unknown',
      agentType,
      files_hint: domainConfig.files_hint || [],
      repo_hints: domainConfig.repos || [],
      specIssues: triage.spec_issues || [],
      specRisk: triage.spec_risk || 'low',
      reasoning: triage.reasoning || '',
    };
  } catch (err) {
    console.error(`  [TaskLoader] Haiku triage failed for ${task.id}: ${err.message}. Falling back to deterministic triage.`);
    await alertInfra('Haiku triage fallback', `Task ${task.id}: ${err.message} — using deterministic triage`);
    return deterministicTriage(task, config);
  }
}

/**
 * Deterministic triage fallback — keyword matching against domain map.
 * Used when Haiku API is unavailable. Never drops a task.
 */
function deterministicTriage(task, config) {
  const domainMap = buildDomainMap(config);
  const text = `${task.title} ${task.description} ${task.category}`.toLowerCase();

  // Find best matching domain by keyword overlap
  let bestDomain = 'unknown';
  let bestScore = 0;
  for (const [name, domainConfig] of Object.entries(domainMap)) {
    const keywords = domainConfig.keywords || [];
    const score = keywords.filter(kw => text.includes(kw.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      bestDomain = name;
    }
  }

  const domainConfig = domainMap[bestDomain] || {};
  const agentType = domainConfig.agentType || domainConfig.persona || (task.category === 'frontend' ? 'frontend' : 'backend');

  return {
    domain: bestDomain,
    agentType,
    files_hint: domainConfig.files_hint || [],
    repo_hints: domainConfig.repos || [],
    specIssues: [],
    specRisk: 'low',
    shouldSplit: false,
    splitSuggestion: '',
    reasoning: `Deterministic fallback: matched domain "${bestDomain}" by keyword overlap`,
  };
}

/**
 * Convert priority string to BullMQ priority number (lower = higher priority).
 */
function priorityToNumber(priority) {
  switch (priority) {
    case 'P0': return 1;
    case 'P1': return 2;
    case 'P2': return 3;
    case 'P3': return 4;
    default: return 5;
  }
}

// Run if called directly
const isMain = process.argv[1]?.endsWith('taskloader.js');
if (isMain) {
  runTaskLoader(process.argv[2]).catch(err => {
    console.error('[TaskLoader] Fatal error:', err);
    process.exit(1);
  });
}
