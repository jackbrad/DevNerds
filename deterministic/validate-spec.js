/**
 * Validate Spec — Deterministic node that checks task has all required fields.
 * Rules live in engine/task-schema.js (single source of truth).
 */

import { validateTask } from '../engine/task-schema.js';

export default function validateSpec(task, _artifacts, projectConfig) {
  const knownProjects = Object.keys(projectConfig?.projects || {});
  const { valid, errors } = validateTask(task, { knownProjects });
  if (!valid) {
    return { verdict: 'FAILED', errors, summary: `Spec validation failed: ${errors.join('; ')}` };
  }
  return { verdict: 'PASSED', summary: 'Spec validation passed' };
}
