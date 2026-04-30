/**
 * Lambda task-schema shim. Reads the canonical task-schema.json that the
 * build script copies into the bundle (aws/build-lambda.sh), then exposes
 * the same constants + validateTask() as engine/task-schema.js.
 *
 * Lambda is bundled separately and cannot reach into ../, so the canonical
 * JSON is copied at build time. To change rules, edit /task-schema.json
 * at the repo root.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, 'task-schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
const C = SCHEMA.constants;

export const TASK_CATEGORIES = C.categories;
export const TASK_PRIORITIES = C.priorities;
export const TASK_STATUSES = C.statuses;
export const TASK_AGENT_TYPES = C.agentTypes;
export const TASK_COMPLEXITIES = C.complexities;
export const MIN_DESCRIPTION_LENGTH = C.minDescriptionLength;
export const MAX_TITLE_LENGTH = C.maxTitleLength;
export const TASK_ID_RE = new RegExp(C.idRegex);
export const TASK_SCHEMA = SCHEMA;

export function validateTask(task, { knownProjects = null, requireId = true } = {}) {
  const errors = [];

  if (requireId) {
    if (!task.id || typeof task.id !== 'string') errors.push('id is required');
    else if (!TASK_ID_RE.test(task.id)) errors.push(`id must match ${TASK_ID_RE}`);
  }

  if (!task.title || typeof task.title !== 'string' || task.title.trim().length === 0) {
    errors.push('title is required');
  } else if (task.title.length > MAX_TITLE_LENGTH) {
    errors.push(`title must be \u2264${MAX_TITLE_LENGTH} chars (got ${task.title.length})`);
  }

  if (!task.description || typeof task.description !== 'string') {
    errors.push('description is required');
  } else if (task.description.length < MIN_DESCRIPTION_LENGTH) {
    errors.push(`description too short (${task.description.length} chars, need ${MIN_DESCRIPTION_LENGTH}+)`);
  }

  if (!task.category) {
    errors.push('category is required');
  } else if (!TASK_CATEGORIES.includes(task.category)) {
    errors.push(`category must be one of [${TASK_CATEGORIES.join(', ')}] \u2014 got "${task.category}"`);
  }

  if (!task.priority) {
    errors.push('priority is required');
  } else if (!TASK_PRIORITIES.includes(task.priority)) {
    errors.push(`priority must be one of [${TASK_PRIORITIES.join(', ')}] \u2014 got "${task.priority}"`);
  }

  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    errors.push('acceptance must be a non-empty array');
  } else if (!task.acceptance.every(a => typeof a === 'string' && a.trim().length > 0)) {
    errors.push('acceptance entries must be non-empty strings');
  }

  if (task.repo_hints !== undefined) {
    if (!Array.isArray(task.repo_hints)) {
      errors.push('repo_hints must be an array of strings');
    } else {
      for (const hint of task.repo_hints) {
        if (typeof hint !== 'string') {
          errors.push(`repo_hints entries must be strings, got ${typeof hint}`);
          continue;
        }
        if (Array.isArray(knownProjects) && !knownProjects.includes(hint)) {
          errors.push(`unknown repo in repo_hints: "${hint}". Known projects: ${knownProjects.join(', ') || '(none configured)'}`);
        }
      }
    }
  }

  if (task.complexity !== undefined && !TASK_COMPLEXITIES.includes(task.complexity)) {
    errors.push(`complexity must be one of [${TASK_COMPLEXITIES.join(', ')}] \u2014 got "${task.complexity}"`);
  }

  if (task.agentType !== undefined && !TASK_AGENT_TYPES.includes(task.agentType)) {
    errors.push(`agentType must be one of [${TASK_AGENT_TYPES.join(', ')}] \u2014 got "${task.agentType}"`);
  }

  if (task.files_hint !== undefined) {
    if (!Array.isArray(task.files_hint)) {
      errors.push('files_hint must be an array of strings');
    } else if (!task.files_hint.every(f => typeof f === 'string')) {
      errors.push('files_hint entries must be strings');
    }
  }

  if (task.status !== undefined && !TASK_STATUSES.includes(task.status)) {
    errors.push(`status must be one of [${TASK_STATUSES.join(', ')}] \u2014 got "${task.status}"`);
  }

  return { valid: errors.length === 0, errors };
}
