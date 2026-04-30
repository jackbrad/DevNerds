/**
 * Terminal WebSocket Server — "Claude in the Loop"
 *
 * Per-task Claude sessions backed by Claude Code's own session persistence
 * (~/.claude/projects/<cwd>/<sessionId>.jsonl). On connect:
 *   - If the task has a `lastSessionId`, launch `claude --resume <id>` so the
 *     conversation picks up exactly where it left off (mobile swipe / refresh
 *     safe).
 *   - Otherwise, generate a fresh UUID, launch `claude --session-id <uuid>`
 *     with the briefing as initial context, and write that id back to the
 *     task in DynamoDB so the next visit resumes it.
 *
 * Protocol:
 *   - String messages: raw terminal input (keystrokes)
 *   - JSON messages:   control frames { type: 'resize', cols, rows }
 *
 * Security: Relies on Tailscale network-level access control.
 */

import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getTask, updateTaskField } from './task-db.js';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';

const MAX_SESSIONS = 5;
const PING_INTERVAL_MS = 30_000;
const CLAUDE_PATH = process.env.DEVNERDS_CLAUDE_PATH || 'claude';
const ARTIFACTS_DIR = process.env.DEVNERDS_ARTIFACTS_DIR ||
  path.resolve(process.cwd(), 'artifacts');
const BRIEFING_DIR = process.env.DEVNERDS_BRIEFING_DIR || '/tmp/devnerds-briefings';

if (!fs.existsSync(BRIEFING_DIR)) fs.mkdirSync(BRIEFING_DIR, { recursive: true });

let projectConfig = null;
loadConfig(DEFAULT_CONFIG_PATH).then(c => { projectConfig = c; }).catch(() => {});

const sessions = new Map();

export function attachTerminalWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/terminal\/([A-Za-z0-9_-]+)$/);
    if (!match) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const taskId = match[1];
      handleConnection(ws, taskId);
    });
  });

  console.log('[Terminal] WebSocket handler attached');
}

function findWorktree(taskId) {
  try {
    const wts = fs.readdirSync('/tmp')
      .filter(d => d.startsWith(`dn-${taskId}-`))
      .map(d => `/tmp/${d}`)
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    return wts[0] || null;
  } catch {
    return null;
  }
}

async function handleConnection(ws, taskId) {
  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', message: `Max ${MAX_SESSIONS} concurrent terminal sessions reached.` }));
    ws.close(1013, 'Too many sessions');
    return;
  }

  let task = null;
  if (projectConfig) {
    try { task = await getTask(taskId, projectConfig); } catch (err) {
      ws.send(`\x1b[33m[DevNerds] Could not load task ${taskId}: ${err.message}\x1b[0m\r\n`);
    }
  }

  const cwd = findWorktree(taskId) || process.env.HOME;
  if (cwd === process.env.HOME) {
    ws.send(`\r\n\x1b[33m[DevNerds] No worktree for ${taskId} (cleaned up?). Resume may not find prior session — opening in $HOME.\x1b[0m\r\n\r\n`);
  }

  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  childEnv.TERM = 'xterm-256color';
  childEnv.DEVNERDS_TASK = taskId;

  const YOLO = '--dangerously-skip-permissions';
  let claudeArgs;
  let isResume = false;
  let newSessionId = null;
  let briefingPath = null;

  // task.lastSessionId is terminal-owned (the human's session). Agentic-node
  // sessions live under task.lastAgentSessionId and must NOT be resumed here —
  // their system prompts demand JSON-only output and break free-form chat.
  const existingSessionId = task?.lastSessionId || null;
  const haveWorktree = cwd !== process.env.HOME;

  if (existingSessionId && haveWorktree) {
    // Resume only when worktree is intact — Claude looks up sessions per-cwd-project,
    // so resuming from $HOME would fail with "session not found".
    claudeArgs = ['--resume', existingSessionId, YOLO];
    isResume = true;
    ws.send(`\x1b[36m[DevNerds] Resuming Claude session ${existingSessionId.slice(0, 8)}... for ${taskId}\x1b[0m\r\n`);
  } else {
    newSessionId = randomUUID();
    try {
      briefingPath = await composeBriefing(taskId, task);
    } catch (err) {
      console.error(`[Terminal] Briefing compose failed for ${taskId}:`, err.message);
      ws.send(`\x1b[33m[DevNerds] Briefing compose failed: ${err.message}\x1b[0m\r\n`);
    }
    // Spawn Claude in interactive mode — the human presses "Start" in the
    // UI to send the kickoff prompt. Otherwise every page refresh / tab
    // re-mount would auto-replay the prompt and burn tokens.
    claudeArgs = ['--session-id', newSessionId, YOLO];
    ws.send(`\x1b[36m[DevNerds] Starting fresh Claude session ${newSessionId.slice(0, 8)}... for ${taskId}\x1b[0m\r\n`);
  }

  const ptyProcess = pty.spawn(CLAUDE_PATH, claudeArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: childEnv,
  });

  console.log(`[Terminal] ${isResume ? 'Resumed' : 'Started'} Claude for ${taskId} (pid: ${ptyProcess.pid}, cwd: ${cwd}, session: ${(existingSessionId || newSessionId)?.slice(0, 8)})`);

  sessions.set(`${taskId}-${ptyProcess.pid}`, { ws, pty: ptyProcess, createdAt: Date.now() });

  if (newSessionId && projectConfig) {
    // Awaited (not fire-and-forget) so we don't race the pipeline's own
    // lastSessionId writes from parseAgentOutput. DDB write is fast; if it
    // fails the terminal still works, but the next visit won't resume.
    try {
      await updateTaskField(taskId, 'lastSessionId', newSessionId, projectConfig);
      console.log(`[Terminal] Wrote lastSessionId=${newSessionId.slice(0, 8)} for ${taskId}`);
    } catch (err) {
      console.error(`[Terminal] Failed to save lastSessionId for ${taskId}:`, err.message);
    }
  }

  let ptyExited = false;

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    ptyExited = true;
    console.log(`[Terminal] Claude exited for ${taskId} (code: ${exitCode})`);
    sessions.delete(`${taskId}-${ptyProcess.pid}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[90m[Claude exited — session saved; reconnect to resume]\x1b[0m\r\n`);
      ws.close(1000, 'Claude exited');
    }
  });

  ws.on('message', (msg) => {
    const str = msg.toString();
    if (str.startsWith('{')) {
      try {
        const ctrl = JSON.parse(str);
        if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
          ptyProcess.resize(ctrl.cols, ctrl.rows);
          return;
        }
      } catch { /* fall through to raw input */ }
    }
    ptyProcess.write(str);
  });

  ws.on('close', () => {
    console.log(`[Terminal] WebSocket closed for ${taskId}`);
    sessions.delete(`${taskId}-${ptyProcess.pid}`);
    if (ptyExited) return;
    try { ptyProcess.kill('SIGTERM'); } catch { /* already dead */ }
    // SIGKILL escalation if SIGTERM is ignored. Gated on ptyExited so a
    // recycled PID never gets signaled.
    setTimeout(() => {
      if (ptyExited) return;
      try { ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000).unref();
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const pingInterval = setInterval(() => {
    if (!ws.isAlive) {
      console.log(`[Terminal] Dead connection detected for ${taskId} — closing`);
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, PING_INTERVAL_MS);
  ws.on('close', () => clearInterval(pingInterval));
}

async function composeBriefing(taskId, task) {
  const lines = [];

  lines.push(`# DevNerds Task Briefing: ${taskId}`);
  lines.push('');
  lines.push('This task is in your inbox awaiting attention. The reason could be many things — it may have been blocked at validation, failed at a pipeline node, flagged by the evaluator, finished pipeline work and waiting for human review, or stopped manually. **Read the status and the pipeline state below first; do not assume.** Then diagnose what the situation calls for, do it, and push the task back through the pipeline.');
  lines.push('');

  if (task) {
    lines.push('## Task Specification');
    lines.push('');
    lines.push(`- **ID:** ${task.id}`);
    lines.push(`- **Title:** ${task.title}`);
    lines.push(`- **Status:** ${task.status}`);
    if (task.priority) lines.push(`- **Priority:** ${task.priority}`);
    if (task.domain) lines.push(`- **Domain:** ${task.domain}`);
    if (task.category) lines.push(`- **Category:** ${task.category}`);
    if (task.agentType) lines.push(`- **Agent Type:** ${task.agentType}`);
    if (task.complexity) lines.push(`- **Complexity:** ${task.complexity}`);
    lines.push('');

    if (task.description) {
      lines.push('### Description');
      lines.push('');
      lines.push(task.description);
      lines.push('');
    }

    if (task.acceptance?.length > 0) {
      lines.push('### Acceptance Criteria');
      lines.push('');
      const criteria = Array.isArray(task.acceptance) ? task.acceptance : [task.acceptance];
      for (const ac of criteria) lines.push(`- ${ac}`);
      lines.push('');
    }

    if (task.files_hint?.length > 0) {
      lines.push('### File Hints');
      lines.push('');
      for (const f of task.files_hint) lines.push(`- \`${f}\``);
      lines.push('');
    }

    if (task.failedNode || task.failureReason) {
      lines.push('## Current Pipeline State');
      lines.push('');
      lines.push('> **Note:** these fields are written when a node fails and are not always cleared on subsequent progress. Treat them as a starting hint, not gospel — verify against the current pipeline state and recent artifacts before acting on them. If the engine has since auto-resumed past the failed node (check `pipeline-state.json` `completedNodes`), this failure may already be moot.');
      lines.push('');
      if (task.failedNode) lines.push(`**Failed at node:** \`${task.failedNode}\``);
      if (task.failureReason) {
        lines.push('');
        lines.push('**Failure reason:**');
        lines.push('```');
        lines.push(task.failureReason);
        lines.push('```');
      }
      if (task.remediation) {
        lines.push('');
        lines.push('**Remediation hint:**');
        lines.push('```');
        lines.push(task.remediation);
        lines.push('```');
      }
      lines.push('');
    }

    if (task.failureHistory?.length > 0) {
      lines.push('## Failure History');
      lines.push('');
      for (const fh of task.failureHistory) {
        lines.push(`- **Attempt ${fh.attempt}** (${fh.node}): ${fh.reason}`);
      }
      lines.push('');
    }
  }

  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  if (fs.existsSync(artifactDir)) {
    lines.push('## Pipeline Artifacts');
    lines.push('');
    lines.push(`Artifacts are at: \`${artifactDir}/\``);
    lines.push('');
    const keyFiles = [
      { file: 'pipeline-state.json', label: 'Pipeline State' },
      { file: 'evaluate_feedback.json', label: 'Evaluator Feedback (bugs/directives)' },
      { file: 'evaluate_output.json', label: 'Evaluator Output' },
      { file: 'build_output.json', label: 'Build Output' },
      { file: 'run-tests_output.json', label: 'Test Results' },
    ];
    if (task?.failedNode) {
      keyFiles.push({ file: `${task.failedNode}_output.json`, label: `Failed Node Output (${task.failedNode})` });
    }
    for (const { file, label } of keyFiles) {
      const filePath = path.join(artifactDir, file);
      if (!fs.existsSync(filePath)) continue;
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > 3000) content = content.slice(0, 3000) + '\n... [truncated]';
        lines.push(`### ${label}`);
        lines.push(`\`${file}\`:`);
        lines.push('```');
        lines.push(content.trim());
        lines.push('```');
        lines.push('');
      } catch { /* skip */ }
    }
  }

  lines.push('## Your Job');
  lines.push('');
  lines.push('1. **Diagnose the situation.** Read the task status, any pipeline state, and the artifacts above. Tell the human:');
  lines.push('   - What you understand the task to be');
  lines.push('   - Why this task is in the inbox right now (validation block? evaluator feedback? failed test? awaiting review?)');
  lines.push('   - What you propose to do about it');
  lines.push('2. **Wait for go-ahead.** Do not change code until the human confirms your plan.');
  lines.push('3. **Do what is needed.** Could be: fixing a block, completing missing work, addressing evaluator feedback, or just confirming things look right. Whatever the situation calls for.');
  lines.push('4. **Stop and hand back to the human.** When your work is done:');
  lines.push('   - **Commit your changes locally** in this worktree (`git add -A && git commit -m "..."`). Do NOT push.');
  lines.push('   - Tell the human plainly: *"Done — ready for you to press Resume Pipeline."*');
  lines.push('   - Do **not** call `/run`, `/restart`, or `/trigger` yourself. The human owns that button. Pressing it kicks the task back into the queue starting from the failed node, and the pipeline picks up your commit from there.');
  lines.push('');
  lines.push('### Updating Task Fields');
  lines.push('');
  lines.push('To change the task itself (description, status, priority, etc.) — for example, to fix a too-short description that blocked validation, or set the task back to TODO — POST to the local `/update` endpoint:');
  lines.push('');
  lines.push('```bash');
  lines.push(`# Set status (TODO, IN_PROGRESS, NEEDS_ATTENTION, etc.)`);
  lines.push(`curl -sX POST http://127.0.0.1:7777/update \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  lines.push(`  -d '{"taskId":"${taskId}","status":"TODO"}'`);
  lines.push('');
  lines.push(`# Update description (and other fields in the same call)`);
  lines.push(`curl -sX POST http://127.0.0.1:7777/update \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  lines.push(`  -d '{"taskId":"${taskId}","description":"a longer, complete description here..."}'`);
  lines.push('```');
  lines.push('');
  lines.push('Allowed fields: `status`, `description`, `title`, `priority`, `category`, `agentType`, `complexity`, `acceptance`, `files_hint`, `remediation`, `domain`. The endpoint writes directly to DynamoDB.');
  lines.push('');
  lines.push('Rules:');
  lines.push('');
  lines.push('- **Smallest change that resolves the situation.** No refactors or scope creep.');
  lines.push('- **Commit your work locally** so the pipeline picks it up when the human resumes. Do NOT push.');
  lines.push('- **Do not call `/run`, `/restart`, or `/trigger`.** The human presses the Resume Pipeline button when they\'re satisfied. You drive the fix; they drive the requeue.');
  lines.push('- **Ask if unsure.** The human is watching.');
  lines.push('- **Never claim success without proof.** Do not say "I updated the task" or "I set the status" unless you actually ran the `/update` curl AND the response was `{"ok":true,...}`. Print the response. If a curl returns an error or non-200, say so plainly. The human is watching DynamoDB; lying gets caught immediately.');

  const briefingPath = path.join(BRIEFING_DIR, `${taskId}-briefing.md`);
  fs.writeFileSync(briefingPath, lines.join('\n'));
  console.log(`[Terminal] Briefing composed for ${taskId} (${lines.length} lines)`);
  return briefingPath;
}
