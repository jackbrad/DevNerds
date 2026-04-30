/**
 * DevNerds Webhook — Lightweight HTTP server.
 * Exposes endpoints to trigger the pipeline from the UI.
 *
 * Listens on port 7777 by default. The recommended deployment puts this
 * behind a private network (Tailscale, WireGuard, VPN) or auth-gated proxy.
 *
 * Endpoints:
 *   POST /trigger          — Run the task loader (scan TODO tasks, queue them)
 *   POST /run/:taskId      — Run a single task immediately
 *   GET  /health           — Health check
 *   GET  /stream/:taskId   — SSE stream of live task output
 */

import http from 'http';
import https from 'https';
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runTaskLoader } from './taskloader.js';
import { attachTerminalWebSocket } from './terminal.js';
import { updateTaskStatus, updateTaskFields } from './task-db.js';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';

const PORT = process.env.DEVNERDS_WEBHOOK_PORT || 7777;
const TLS_PORT = process.env.DEVNERDS_WEBHOOK_TLS_PORT || 7778;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function respond(res, statusCode, body) {
  res.writeHead(statusCode, CORS);
  res.end(JSON.stringify(body));
}

// Reject CLI-flag-shaped IDs (--help, -v) and other ill-formed strings.
// Must start with alphanumeric or underscore; subsequent chars may include hyphen.
const TASK_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

let cachedConfig = null;
async function getConfig() {
  if (!cachedConfig) cachedConfig = await loadConfig(DEFAULT_CONFIG_PATH);
  return cachedConfig;
}

const UPDATE_ALLOWED_FIELDS = new Set([
  'description', 'title', 'priority', 'category', 'agentType',
  'complexity', 'acceptance', 'files_hint', 'remediation', 'domain',
]);

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Health check
    if (req.method === 'GET' && path === '/health') {
      respond(res, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    // SSE stream — live task output (tails shared JSONL log file)
    if (req.method === 'GET' && path.startsWith('/stream/')) {
      const taskId = path.replace('/stream/', '');
      if (!taskId) {
        respond(res, 400, { error: 'taskId required' });
        return;
      }

      const STREAM_LOG = '/tmp/devnerds-stream.jsonl';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      res.write(': connected\n\n');

      // Tail by byte offset so we don't re-read the entire log every tick.
      // Start at end-of-file: a fresh SSE connection only needs new events.
      let bytePos = 0;
      let lineCarry = '';
      try { bytePos = statSync(STREAM_LOG).size; } catch { /* missing on first run */ }

      const checkInterval = setInterval(() => {
        let fd = -1;
        try {
          const st = statSync(STREAM_LOG);
          // Detect rotation/truncation: if file shrunk, restart from 0.
          if (st.size < bytePos) {
            bytePos = 0;
            lineCarry = '';
          }
          if (st.size === bytePos) return;

          const toRead = Math.min(st.size - bytePos, 1_000_000); // 1MB cap per tick
          const buf = Buffer.alloc(toRead);
          fd = openSync(STREAM_LOG, 'r');
          const bytesRead = readSync(fd, buf, 0, toRead, bytePos);
          bytePos += bytesRead;

          const chunk = lineCarry + buf.slice(0, bytesRead).toString('utf-8');
          const parts = chunk.split('\n');
          lineCarry = parts.pop(); // last element is incomplete (or '')

          for (const line of parts) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.taskId === taskId) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            } catch { /* skip malformed lines */ }
          }
        } catch { /* file missing / transient errors — try again next tick */ }
        finally { if (fd !== -1) try { closeSync(fd); } catch {} }
      }, 500);

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 15000);

      // Cleanup on disconnect
      req.on('close', () => {
        clearInterval(checkInterval);
        clearInterval(heartbeat);
      });

      return;
    }

    // Trigger task loader — scan and queue TODO tasks
    if (req.method === 'POST' && path === '/trigger') {
      const configPath = url.searchParams.get('config') || undefined;
      console.log(`[Webhook] Trigger received — running task loader...`);

      runTaskLoader(configPath)
        .then(() => console.log('[Webhook] TaskLoader completed'))
        .catch(err => console.error('[Webhook] TaskLoader error:', err.message));

      respond(res, 200, {
        ok: true,
        message: 'TaskLoader triggered — scanning for TODO tasks',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Run a single task
    if (req.method === 'POST' && path.startsWith('/run/')) {
      const taskId = path.replace('/run/', '');
      if (!isValidTaskId(taskId)) {
        respond(res, 400, { error: 'invalid taskId — must match /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/' });
        return;
      }

      const configPath = url.searchParams.get('config') || undefined;
      console.log(`[Webhook] Run task ${taskId}`);

      import('./run-single-task.js')
        .then(mod => mod.runTask(taskId, null, configPath))
        .then(result => console.log(`[Webhook] Task ${taskId} → ${result.finalVerdict}`))
        .catch(err => console.error(`[Webhook] Task ${taskId} error:`, err.message));

      respond(res, 200, {
        ok: true,
        message: `Task ${taskId} triggered`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update task fields (status, description, etc.) — used by the human-in-the-loop
    // terminal so Claude can fix bad descriptions, set status, etc.
    if (req.method === 'POST' && path === '/update') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { respond(res, 400, { error: e.message }); return; }

      if (!isValidTaskId(body.taskId)) {
        respond(res, 400, { error: 'invalid taskId' });
        return;
      }
      const taskId = body.taskId;

      // Validate every requested field up front — reject the whole request
      // before writing anything, so a bad key doesn't leave a partial update.
      const fieldUpdates = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === 'taskId' || k === 'status' || k === 'statusMetadata') continue;
        if (!UPDATE_ALLOWED_FIELDS.has(k)) {
          respond(res, 400, { error: `field '${k}' not in allow-list` });
          return;
        }
        fieldUpdates[k] = v;
      }

      try {
        const cfg = await getConfig();
        const applied = [];

        // One atomic DDB call. If status changes, use updateTaskStatus (which
        // also sets claimedAt/completedAt/etc. and accepts other fields as
        // metadata). Otherwise, use updateTaskFields directly.
        if (body.status) {
          const statusMetadata = { ...fieldUpdates, ...(body.statusMetadata || {}) };
          await updateTaskStatus(taskId, body.status, cfg, statusMetadata);
          applied.push('status', ...Object.keys(fieldUpdates));
        } else if (Object.keys(fieldUpdates).length > 0) {
          await updateTaskFields(taskId, fieldUpdates, cfg);
          applied.push(...Object.keys(fieldUpdates));
        }

        respond(res, 200, { ok: true, taskId, applied, timestamp: new Date().toISOString() });
      } catch (err) {
        console.error(`[Webhook] /update ${taskId} error:`, err.message);
        respond(res, 500, { error: err.message });
      }
      return;
    }

    // Restart a task from a specific blueprint node (preserves worktree)
    if (req.method === 'POST' && path.match(/^\/restart\/[^/]+\/[^/]+$/)) {
      const parts = path.split('/');
      const taskId = parts[2];
      const fromNode = parts[3];
      if (!isValidTaskId(taskId) || !fromNode) {
        respond(res, 400, { error: 'invalid taskId or missing nodeId — /restart/:taskId/:nodeId, taskId must match /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/' });
        return;
      }

      const configPath = url.searchParams.get('config') || undefined;
      console.log(`[Webhook] Restart task ${taskId} from node ${fromNode}`);

      import('./run-single-task.js')
        .then(mod => mod.runTask(taskId, null, configPath, { resumeFrom: fromNode }))
        .then(result => console.log(`[Webhook] Task ${taskId} restart → ${result.finalVerdict}`))
        .catch(err => console.error(`[Webhook] Task ${taskId} restart error:`, err.message));

      respond(res, 200, {
        ok: true,
        message: `Task ${taskId} restarting from node ${fromNode}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 404
    respond(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[Webhook] Error:', err);
    respond(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[Webhook] DevNerds webhook listening on port ${PORT} (HTTP)`);
  console.log(`[Webhook] Trigger:  POST http://100.100.31.32:${PORT}/trigger`);
  console.log(`[Webhook] Stream:   GET  http://100.100.31.32:${PORT}/stream/{taskId}`);
  console.log(`[Webhook] Run:      POST http://100.100.31.32:${PORT}/run/{taskId}`);
  console.log(`[Webhook] Restart:  POST http://100.100.31.32:${PORT}/restart/{taskId}/{nodeId}`);
});

// Attach terminal WebSocket handler to HTTP server
attachTerminalWebSocket(server);

// TLS server for browser access (HTTPS page needs wss://)
const certPath = path.join(__dirname, '..', 'config', 'tls-cert.pem');
const keyPath = path.join(__dirname, '..', 'config', 'tls-key.pem');

if (existsSync(certPath) && existsSync(keyPath)) {
  const tlsServer = https.createServer({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  }, server.listeners('request')[0]); // Share the same request handler

  tlsServer.listen(TLS_PORT, () => {
    console.log(`[Webhook] TLS server listening on port ${TLS_PORT} (HTTPS/WSS)`);
    console.log(`[Webhook] Terminal: wss://100.100.31.32:${TLS_PORT}/terminal/{taskId}`);
  });

  // Attach terminal WebSocket to TLS server too
  attachTerminalWebSocket(tlsServer);
} else {
  console.log('[Webhook] No TLS certs found — skipping HTTPS server');
}
