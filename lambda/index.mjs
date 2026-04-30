// DevNerds API Lambda — single Lambda, route-based dispatch.
//
// Routes:
//   GET  /                         → quips ticker (the only thing the UI pulls from /)
//   GET  /tasks                    → list of all tasks
//   GET  /tasks/:id                → single task with pipeline state + artifact list
//   GET  /tasks/:id/artifacts      → list artifact files from S3
//   GET  /tasks/:id/artifacts/*    → read artifact content from S3
//   GET  /blueprints               → pipeline blueprint definitions
//   GET  /schema                   → canonical task schema (constants + JSON Schema)
//   POST /tasks                    → create a new task (schema-validated)
//   POST /tasks/assist             → AI assist for filling out a task draft
//   POST /tasks/:id/approve        → approve at a human gate
//   POST /tasks/:id/reject         → reject at a human gate
//   POST /tasks/:id/notes          → append a note to a task
//   POST /update                   → update task fields (status, title, etc.)
//   POST /add-note                 → append a note to a task (alt form)

import { DynamoDBClient, ScanCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { validateTask, TASK_CATEGORIES, TASK_PRIORITIES, MIN_DESCRIPTION_LENGTH, TASK_SCHEMA } from './task-schema.mjs';

const dynamo = new DynamoDBClient({ region: 'us-east-1' });
const s3 = new S3Client({ region: 'us-east-1' });
const ssm = new SSMClient({ region: 'us-east-1' });

const TASK_TABLE = process.env.TASK_TABLE || 'devnerds-tasks';
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET;
const QUIPS_BUCKET = ARTIFACTS_BUCKET;
const QUIPS_KEY = 'api/quips-cache.json';
const QUIPS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const XAI_API_KEY = process.env.XAI_API_KEY;
const SSM_ANTHROPIC_KEY_PATH = '/devnerds/anthropic-api-key';

// Module-level cache — populated on first call, reused across warm invocations
let cachedAnthropicKey = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

// ===== TASK HELPERS =====

const PERSONA_MAP = { pixel: 'frontend', runway: 'backend', lander: 'backend' };

function taskFromDynamo(item) {
  const t = unmarshall(item);
  const rawAgentType = t.agentType || t.persona || '';
  const derivedId = t.pk && t.pk.startsWith('TASK#') ? t.pk.slice(5) : '';
  return {
    id: t.id || derivedId,
    title: t.title || '',
    status: t.status || '',
    priority: t.priority || 'P3',
    category: t.category || '',
    description: t.description || '',
    assignee: t.assignee || '',
    domain: t.domain || '',
    agentType: PERSONA_MAP[rawAgentType] || rawAgentType,
    blueprint: t.blueprint || t.currentBlueprint || '',
    currentNode: t.currentNode || '',
    currentRepo: t.currentRepo || '',
    repo_hints: t.repo_hints || [],
    failedNode: t.failedNode || '',
    failureReason: t.failureReason || '',
    failCount: t.failCount || 0,
    pipelineState: t.pipelineState || null,
    acceptance: t.acceptance || [],
    notes: t.notes || [],
    createdAt: t.createdAt || '',
    updatedAt: t.updatedAt || '',
    claimedAt: t.claimedAt || '',
    completedAt: t.completedAt || '',
    complexity: t.complexity || '',
    cross_domain: t.cross_domain || false,
    files_hint: t.files_hint || [],
  };
}

// ===== GET ALL TASKS =====
async function getTasks() {
  const items = [];
  let lastKey = undefined;

  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: TASK_TABLE,
      FilterExpression: 'sk = :sk',
      ExpressionAttributeValues: { ':sk': { S: 'DETAILS' } },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of res.Items || []) {
      items.push(taskFromDynamo(item));
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const statusOrder = { IN_PROGRESS: 0, NEEDS_ATTENTION: 1, AWAITING_REVIEW: 2, TESTING: 3, FAILED: 4, BLOCKED: 5, TODO: 6, CLOSED: 7, VERIFIED: 8, MERGED: 9 };
  items.sort((a, b) => {
    const p = (a.priority || 'P9').localeCompare(b.priority || 'P9');
    if (p !== 0) return p;
    return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
  });

  return items;
}

// ===== GET SINGLE TASK =====
async function getTask(taskId) {
  const res = await dynamo.send(new GetItemCommand({
    TableName: TASK_TABLE,
    Key: { pk: { S: `TASK#${taskId}` }, sk: { S: 'DETAILS' } },
  }));
  if (!res.Item) return null;
  return taskFromDynamo(res.Item);
}

// ===== ARTIFACTS =====
async function listArtifacts(taskId) {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: ARTIFACTS_BUCKET,
    Prefix: `${taskId}/`,
  }));
  return (res.Contents || []).map(obj => ({
    name: obj.Key.replace(`${taskId}/`, ''),
    size: obj.Size,
    lastModified: obj.LastModified?.toISOString(),
  }));
}

async function readArtifact(taskId, filename) {
  const res = await s3.send(new GetObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: `${taskId}/${filename}`,
  }));
  return await res.Body.transformToString();
}

// ===== PIPELINE =====
// NOTE: This list MUST stay in sync with blueprints/pipeline.js. The Lambda
// is its own deploy unit so it can't import the engine module — duplicate the
// node ids/edges and update both sides whenever the pipeline shape changes.
function getBlueprints() {
  // Returned as an array because the UI iterates; only one pipeline today.
  return [
    {
      name: 'pipeline',
      description: 'DevNerds multi-repo pipeline: plan, build per repo, evaluate, atomic push',
      nodes: [
        { id: 'validate-spec', type: 'deterministic', on_success: 'worktrees-setup', on_failure: 'BLOCKED' },
        { id: 'worktrees-setup', type: 'deterministic', on_success: 'baseline-check', on_failure: 'FAILED' },
        { id: 'baseline-check', type: 'deterministic', on_success: 'plan', on_failure: 'plan' },
        { id: 'plan', type: 'agentic', on_success: 'worktrees-setup-from-plan', on_failure: 'cleanup-on-failure' },
        { id: 'worktrees-setup-from-plan', type: 'deterministic', on_success: 'build', on_failure: 'cleanup-on-failure' },
        { id: 'build', type: 'agentic', for_each_repo: true, on_success: 'lint-autofix', on_failure: 'cleanup-on-failure' },
        { id: 'lint-autofix', type: 'deterministic', for_each_repo: true, on_success: 'run-tests', on_failure: 'run-tests' },
        { id: 'run-tests', type: 'deterministic', for_each_repo: true, on_success: 'auto-commit', on_failure: 'cleanup-on-failure' },
        { id: 'auto-commit', type: 'deterministic', for_each_repo: true, on_success: 'evaluate', on_failure: 'cleanup-on-failure' },
        { id: 'evaluate', type: 'agentic', on_success: 'atomic-push', on_failure: 'cleanup-on-failure' },
        { id: 'atomic-push', type: 'deterministic', on_success: 'verify-push', on_failure: 'cleanup-on-failure' },
        { id: 'verify-push', type: 'deterministic', on_success: 'cleanup-on-success', on_failure: 'cleanup-on-success' },
        { id: 'cleanup-on-success', type: 'deterministic', on_success: 'DONE', on_failure: 'DONE' },
        { id: 'cleanup-on-failure', type: 'deterministic', on_success: 'FAILED', on_failure: 'FAILED' },
      ],
    },
  ];
}

// Allocate the next GF-### id by scanning for the current max.
// Low-volume workload so a scan is fine; no counter row needed.
async function nextGfId() {
  let max = 0;
  let lastKey;
  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: TASK_TABLE,
      ProjectionExpression: '#id',
      FilterExpression: 'sk = :sk AND begins_with(#id, :prefix)',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':sk': { S: 'DETAILS' }, ':prefix': { S: 'GF-' } },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items || []) {
      const m = /^GF-(\d+)$/.exec(item.id?.S || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return `GF-${String(max + 1).padStart(3, '0')}`;
}

// ===== CREATE TASK =====
async function createTask(body) {
  let { id } = body;
  const { title, description, category, priority, acceptance, complexity, cross_domain, repo_hints } = body;

  // If no id supplied, allocate the next GF-### server-side.
  if (!id || id === 'auto' || (typeof id === 'string' && id.trim() === '')) {
    id = await nextGfId();
  }

  // Validate against the shared task schema (rules in lambda/task-schema.js,
  // mirrored from engine/task-schema.js).
  const candidate = { id, title, description, category, priority, acceptance, complexity, repo_hints };
  const { valid, errors } = validateTask(candidate, { requireId: false });
  if (!valid) throw new Error(errors.join('; '));

  const now = new Date().toISOString();
  const item = {
    pk: `TASK#${id}`,
    sk: 'DETAILS',
    id,
    title,
    description,
    category,
    priority,
    acceptance,
    status: 'TODO',
    createdAt: now,
    updatedAt: now,
    failCount: 0,
    notes: [],
  };
  if (complexity) item.complexity = complexity;
  if (cross_domain) item.cross_domain = cross_domain;
  if (repo_hints && repo_hints.length > 0) item.repo_hints = repo_hints;

  await dynamo.send(new PutItemCommand({
    TableName: TASK_TABLE,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  return item;
}

// ===== APPROVE / REJECT =====
async function approveTask(taskId) {
  const now = new Date().toISOString();
  await dynamo.send(new UpdateItemCommand({
    TableName: TASK_TABLE,
    Key: { pk: { S: `TASK#${taskId}` }, sk: { S: 'DETAILS' } },
    UpdateExpression: 'SET #s = :s, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': { S: 'IN_PROGRESS' }, ':now': { S: now } },
  }));
  return { ok: true, message: 'Task approved, pipeline will resume' };
}

async function rejectTask(taskId, reason) {
  const now = new Date().toISOString();
  const note = { author: 'human', timestamp: now, text: reason || 'Rejected via UI' };
  await dynamo.send(new UpdateItemCommand({
    TableName: TASK_TABLE,
    Key: { pk: { S: `TASK#${taskId}` }, sk: { S: 'DETAILS' } },
    UpdateExpression: 'SET #s = :s, updatedAt = :now, failureReason = :r, failCount = if_not_exists(failCount, :zero) + :one, notes = list_append(if_not_exists(notes, :empty), :note)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': { S: 'FAILED' },
      ':now': { S: now },
      ':r': { S: reason || 'Rejected via UI' },
      ':one': { N: '1' },
      ':zero': { N: '0' },
      ':note': { L: [{ M: marshall(note) }] },
      ':empty': { L: [] },
    },
  }));
  return { ok: true, message: 'Task rejected' };
}

// ===== ADD NOTE =====
async function addNote(taskId, author, text) {
  const now = new Date().toISOString();
  const note = { author, timestamp: now, text };
  await dynamo.send(new UpdateItemCommand({
    TableName: TASK_TABLE,
    Key: { pk: { S: `TASK#${taskId}` }, sk: { S: 'DETAILS' } },
    UpdateExpression: 'SET notes = list_append(if_not_exists(notes, :empty), :note), updatedAt = :now',
    ExpressionAttributeValues: {
      ':note': { L: [{ M: marshall(note) }] },
      ':empty': { L: [] },
      ':now': { S: now },
    },
  }));
  return { ok: true };
}

// ===== UPDATE TASK =====
async function updateTask(body) {
  const { taskId } = body;
  if (!taskId) throw new Error('taskId required');

  const updates = ['updatedAt = :u'];
  const names = {};
  const values = { ':u': { S: new Date().toISOString() } };

  if (body.status) { updates.push('#s = :s'); names['#s'] = 'status'; values[':s'] = { S: body.status }; }
  if (body.title) { updates.push('title = :t'); values[':t'] = { S: body.title }; }
  if (body.priority) { updates.push('priority = :p'); values[':p'] = { S: body.priority }; }
  if (body.category) { updates.push('category = :c'); values[':c'] = { S: body.category }; }
  if (body.assignee !== undefined) { updates.push('assignee = :a'); values[':a'] = { S: body.assignee }; }
  if (body.description !== undefined) { updates.push('description = :d'); values[':d'] = { S: body.description }; }

  await dynamo.send(new UpdateItemCommand({
    TableName: TASK_TABLE,
    Key: { pk: { S: `TASK#${taskId}` }, sk: { S: 'DETAILS' } },
    UpdateExpression: 'SET ' + updates.join(', '),
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));

  return { ok: true, taskId };
}

// ===== QUIPS =====
async function getQuips() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: QUIPS_BUCKET, Key: QUIPS_KEY }));
    const body = await res.Body.transformToString();
    const cache = JSON.parse(body);
    if (cache.generated && (Date.now() - new Date(cache.generated).getTime()) < QUIPS_MAX_AGE_MS) {
      return cache;
    }
  } catch {}

  const quips = await generateQuips();
  const cache = { quips, generated: new Date().toISOString() };
  // Best-effort cache write — never let a quips failure take down the API.
  try {
    await s3.send(new PutObjectCommand({
      Bucket: QUIPS_BUCKET, Key: QUIPS_KEY,
      Body: JSON.stringify(cache), ContentType: 'application/json',
    }));
  } catch (e) {
    console.warn('quips cache write failed:', e?.message || e);
  }
  return cache;
}

async function generateQuips() {
  if (!XAI_API_KEY) return ['Quip generation offline.'];

  const SYSTEM = `You write one-liner quips for a developer dashboard called "DevNerds".
The dashboard tracks an autonomous code factory where stateless Claude Code instances build code through blueprint pipelines: validate-spec, questions, research, design, build, lint, test, evaluate, ship.
Be FUN, cheeky, light. Clever friends at a pub. No emojis. MAX 15 words each.`;

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({
      model: 'grok-3-mini-fast',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Generate exactly 100 unique quips. One per line. No numbering, no quotes, no bullets. Just raw lines.' },
      ],
      max_tokens: 4000,
      temperature: 1.2,
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim() || '';
  return text.split('\n').map(l => l.trim().replace(/^[-*\d.]+\s*/, '')).filter(l => l.length > 10 && l.length < 150);
}

// ===== TASK ASSIST (AI) =====

// Optional: deployments can supply a JSON object mapping repo name → one-line
// description via the DEVNERDS_REPO_DESCRIPTIONS env var. The assist prompt
// inlines these so the LLM can suggest sensible repo_hints.
const REPO_DESCRIPTIONS = (() => {
  const raw = process.env.DEVNERDS_REPO_DESCRIPTIONS;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
})();

const REPO_DESCRIPTIONS_BLOCK = Object.keys(REPO_DESCRIPTIONS).length === 0
  ? '(no repo descriptions configured — suggest repo_hints sparingly)'
  : Object.entries(REPO_DESCRIPTIONS).map(([repo, desc]) => `- ${repo}: ${desc}`).join('\n');

const ASSIST_SYSTEM_PROMPT = `You help engineers file pipeline-ready tasks for the DevNerds automation factory.

Repos and their responsibilities:
${REPO_DESCRIPTIONS_BLOCK}

Rules:
- Descriptions must be ${MIN_DESCRIPTION_LENGTH}+ characters, specific, and actionable.
- Acceptance criteria must be verifiable and testable. Avoid "works correctly", "looks good", "is fast". Each criterion must describe a concrete observable outcome.
- Flag ambiguity as gaps (questions) rather than guessing.
- Suggest repo_hints only when clearly relevant. Include a short rationale for each.
- Warn about cross-repo changes, auth/security implications, payment flows, or tasks lacking clear scope.
- category must be one of: ${TASK_CATEGORIES.join(', ')}
- priority must be one of: ${TASK_PRIORITIES.join(', ')}

Respond with ONLY a valid JSON object, no markdown fences, no prose outside JSON.

Output schema (use null for fields where the original is already fine):
{
  "suggestions": {
    "title": "string or null",
    "description": "string or null",
    "acceptance": ["string", ...] or null,
    "repo_hints": [{"repo": "string", "why": "string"}, ...] or null,
    "category": "string or null",
    "priority": "string or null"
  },
  "gaps": [
    {"question": "string", "why_it_matters": "string"}
  ],
  "warnings": ["string", ...]
}`;

async function getAnthropicKey() {
  if (cachedAnthropicKey) return cachedAnthropicKey;
  const res = await ssm.send(new GetParameterCommand({
    Name: SSM_ANTHROPIC_KEY_PATH,
    WithDecryption: true,
  }));
  cachedAnthropicKey = res.Parameter.Value;
  return cachedAnthropicKey;
}

async function handleTaskAssist(body) {
  const { draft = {}, mode = 'refine', question_answer } = body;

  let userMessage;
  if (mode === 'answer' && question_answer) {
    userMessage = `Current draft:\n${JSON.stringify(draft, null, 2)}\n\nThe user answered a gap question:\n${question_answer}\n\nFold this answer into the draft and return updated suggestions.`;
  } else {
    userMessage = `Please review this task draft and return suggestions:\n${JSON.stringify(draft, null, 2)}`;
  }

  let apiKey;
  try {
    apiKey = await getAnthropicKey();
  } catch (e) {
    console.error('SSM fetch failed:', e.message);
    return { error: 'AI assistant temporarily unavailable — please fill the form manually' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);

  let rawText;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        temperature: 0.2,
        system: ASSIST_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      console.error('Anthropic API error:', res.status, errText);
      return { error: 'AI assistant temporarily unavailable — please fill the form manually' };
    }

    const data = await res.json();
    rawText = data.content?.[0]?.text || '';
  } catch (e) {
    clearTimeout(timeoutId);
    console.error('Anthropic fetch error:', e.message);
    return { error: 'AI assistant temporarily unavailable — please fill the form manually' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    console.error('Anthropic response parse failed. Raw output:', rawText);
    return { error: 'AI assistant temporarily unavailable — please fill the form manually' };
  }

  // Defensive shape validation
  const suggestions = parsed.suggestions && typeof parsed.suggestions === 'object' ? parsed.suggestions : {};
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  return { suggestions, gaps, warnings };
}

// ===== ROUTE MATCHING =====
function matchRoute(method, path) {
  // Extract path parts after the API Gateway stage
  const parts = path.replace(/^\/+/, '').split('/');

  // POST routes
  if (method === 'POST') {
    if (parts[0] === 'update') return { handler: 'update' };
    if (parts[0] === 'add-note') return { handler: 'add-note' };
    if (parts[0] === 'tasks' && parts[1] === 'assist' && parts.length === 2) return { handler: 'task-assist' };
    if (parts[0] === 'tasks' && parts.length === 1) return { handler: 'create-task' };
    if (parts[0] === 'tasks' && parts[2] === 'approve') return { handler: 'approve', taskId: parts[1] };
    if (parts[0] === 'tasks' && parts[2] === 'reject') return { handler: 'reject', taskId: parts[1] };
    if (parts[0] === 'tasks' && parts[2] === 'notes') return { handler: 'task-note', taskId: parts[1] };
  }

  // GET routes
  if (method === 'GET') {
    if (parts[0] === 'schema') return { handler: 'schema' };
    if (parts[0] === 'blueprints') return { handler: 'blueprints' };
    if (parts[0] === 'tasks' && parts.length === 1) return { handler: 'tasks-list' };
    if (parts[0] === 'tasks' && parts[2] === 'artifacts' && parts[3]) {
      return { handler: 'artifact-read', taskId: parts[1], filename: parts.slice(3).join('/') };
    }
    if (parts[0] === 'tasks' && parts[2] === 'artifacts') return { handler: 'artifact-list', taskId: parts[1] };
    if (parts[0] === 'tasks' && parts.length === 2) return { handler: 'task-detail', taskId: parts[1] };
  }

  return { handler: 'default' };
}

// ===== HANDLER =====
export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS' || event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const rawPath = event.rawPath || event.path || '/';
  const route = matchRoute(method, rawPath);

  try {
    switch (route.handler) {
      case 'update': {
        const body = JSON.parse(event.body || '{}');
        return respond(200, await updateTask(body));
      }

      case 'add-note': {
        const body = JSON.parse(event.body || '{}');
        if (!body.taskId) return respond(400, { error: 'taskId required' });
        return respond(200, await addNote(body.taskId, body.author || 'unknown', body.text || ''));
      }

      case 'tasks-list': {
        const tasks = await getTasks();
        return respond(200, { tasks, count: tasks.length });
      }

      case 'task-detail': {
        const task = await getTask(route.taskId);
        if (!task) return respond(404, { error: 'Task not found' });
        // Also fetch artifacts list to know what's available
        let artifacts = [];
        try { artifacts = await listArtifacts(route.taskId); } catch {}
        // Always return the single pipeline definition
        const blueprints = getBlueprints();
        const blueprint = blueprints[0]; // single pipeline
        return respond(200, { task, artifacts, blueprint });
      }

      case 'artifact-list': {
        const files = await listArtifacts(route.taskId);
        return respond(200, { files });
      }

      case 'artifact-read': {
        try {
          const content = await readArtifact(route.taskId, route.filename);
          const type = route.filename.endsWith('.json') ? 'json' : route.filename.endsWith('.md') ? 'markdown' : 'text';
          return respond(200, { name: route.filename, content, type });
        } catch {
          return respond(404, { error: 'Artifact not found' });
        }
      }

      case 'blueprints':
        return respond(200, { blueprints: getBlueprints() });

      case 'schema':
        return respond(200, TASK_SCHEMA);

      case 'create-task': {
        const body = JSON.parse(event.body || '{}');
        const task = await createTask(body);
        return respond(201, { task });
      }

      case 'approve':
        return respond(200, await approveTask(route.taskId));

      case 'reject': {
        const body = JSON.parse(event.body || '{}');
        return respond(200, await rejectTask(route.taskId, body.reason));
      }

      case 'task-note': {
        const body = JSON.parse(event.body || '{}');
        return respond(200, await addNote(route.taskId, body.author || 'human', body.text || ''));
      }

      case 'task-assist': {
        const body = JSON.parse(event.body || '{}');
        return respond(200, await handleTaskAssist(body));
      }

      // Default: only the quips ticker payload — UI fetches tasks via /tasks.
      default: {
        const quipCache = await getQuips();
        return respond(200, {
          quips: quipCache.quips,
          quipsGenerated: quipCache.generated,
        });
      }
    }
  } catch (e) {
    return respond(e.message.includes('required') || e.message.includes('invalid') ? 400 : 500, { error: e.message });
  }
};
