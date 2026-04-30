// API_BASE was here previously — runtime URL now comes from VITE_API_URL in
// .env (read by ui/src/auth/api-client.js). Don't add a constant; that creates
// a second source of truth and the env wins.

// Base URL for the engine webhook. Empty string = same-origin (the recommended
// deployment puts a reverse proxy in front of the engine, e.g. Caddy on the
// same host, that forwards /restart/*, /stream/*, /trigger, /terminal/* to
// the engine on 127.0.0.1:7777). Override with VITE_DEVNERDS_WEBHOOK.
export const DEVNERDS_WEBHOOK = import.meta.env?.VITE_DEVNERDS_WEBHOOK || '';

export const TABS = {
  live: {
    label: 'Live',
    statuses: [],
    description: 'Live output from running task',
  },
  inbox: {
    label: 'Inbox',
    statuses: ['NEEDS_ATTENTION', 'AWAITING_REVIEW', 'FAILED', 'BLOCKED', 'STOPPED'],
    description: 'Tasks needing human attention',
  },
  factory: {
    label: 'Factory',
    statuses: ['IN_PROGRESS', 'TODO', 'TESTING'],
    description: 'Active work and queue',
  },
  shipped: {
    label: 'Shipped',
    statuses: ['CLOSED', 'DONE', 'VERIFIED', 'MERGED'],
    description: 'Completed work',
  },
};

// Imported from the canonical task schema at repo root. Single source of truth —
// engine/task-schema.js, lambda/task-schema.mjs, and this file all read it.
import taskSchema from '../../../task-schema.json';

export const TASK_SCHEMA = taskSchema;
export const ALL_STATUSES = taskSchema.constants.statuses;
export const ALL_PRIORITIES = taskSchema.constants.priorities;
export const ALL_CATEGORIES = taskSchema.constants.categories;
export const ALL_AGENT_TYPES = taskSchema.constants.agentTypes;
export const ALL_COMPLEXITIES = taskSchema.constants.complexities;
export const MIN_DESCRIPTION_LENGTH = taskSchema.constants.minDescriptionLength;
export const MAX_TITLE_LENGTH = taskSchema.constants.maxTitleLength;
export const TASK_ID_RE = new RegExp(taskSchema.constants.idRegex);

export const STATUS_COLORS = {
  TODO: 'status-todo',
  IN_PROGRESS: 'status-progress',
  NEEDS_ATTENTION: 'status-awaiting',
  AWAITING_REVIEW: 'status-awaiting',
  TESTING: 'status-testing',
  CLOSED: 'status-closed',
  DONE: 'status-closed',
  VERIFIED: 'status-closed',
  MERGED: 'status-blocked',
  FAILED: 'status-failed',
  BLOCKED: 'status-blocked',
  STOPPED: 'status-awaiting',
};

export const PRIORITY_COLORS = {
  P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3',
};

export const STATUS_ORDER = {
  IN_PROGRESS: 0, NEEDS_ATTENTION: 1, AWAITING_REVIEW: 2, TESTING: 3, FAILED: 4,
  BLOCKED: 4, TODO: 5, CLOSED: 6, VERIFIED: 7, MERGED: 8, STOPPED: 9,
};

export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function filterTasks(tasks, { search, priorities, categories }) {
  return tasks.filter(t => {
    if (priorities.size > 0 && !priorities.has(t.priority)) return false;
    if (categories.size > 0 && !categories.has(t.category)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!t.id?.toLowerCase().includes(q) && !t.title?.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

export const PRI_PILL_STYLES = {
  P0: 'bg-p0/15 text-p0',
  P1: 'bg-p1/15 text-p1',
  P2: 'bg-p2/15 text-p2',
  P3: 'bg-p3/15 text-p3',
};

export const PRI_ACTIVE_STYLES = {
  P0: 'bg-p0/20 text-p0 border-p0/30',
  P1: 'bg-p1/20 text-p1 border-p1/30',
  P2: 'bg-p2/20 text-p2 border-p2/30',
  P3: 'bg-p3/20 text-p3 border-p3/30',
};

// List of repos this DevNerds instance manages. Override at build time via the
// VITE_DEVNERDS_REPOS env var (comma-separated), or edit this file for your fork.
export const ALL_REPOS = (import.meta.env?.VITE_DEVNERDS_REPOS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
