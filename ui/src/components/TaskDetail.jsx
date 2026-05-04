import { useState, useEffect } from 'react';
import { fetchTaskDetail } from '../lib/api';
import { apiFetch } from '../auth/api-client';
import StatusPill from './StatusPill';
import PipelineTranscript from './PipelineTranscript';
import ActivityLog from './ActivityLog';
import NewTaskModal from './NewTaskModal';
import { PRI_PILL_STYLES, DEVNERDS_WEBHOOK } from '../lib/constants';

const STUCK_STATUSES = new Set(['NEEDS_ATTENTION', 'FAILED', 'BLOCKED', 'STOPPED', 'AWAITING_REVIEW']);

export default function TaskDetail({ taskId, onClose, embedded = false, onOpenTerminal, terminalOpen = false }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState(null); // { kind: 'ok'|'error', text: string } | null
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [editing, setEditing] = useState(false);

  async function refreshDetail() {
    try {
      const fresh = await fetchTaskDetail(taskId);
      setDetail(fresh);
    } catch (e) {
      console.error('refresh failed:', e);
    }
  }

  async function setTaskStatus(newStatus) {
    setStatusUpdating(true);
    try {
      await apiFetch('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: newStatus }),
      });
      // Refresh the detail so the UI reflects the new state.
      const fresh = await fetchTaskDetail(taskId);
      setDetail(fresh);
    } catch (e) {
      alert(`Failed to set status: ${e.message || e}`);
    }
    setStatusUpdating(false);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTaskDetail(taskId)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  const pad = embedded
    ? 'px-10 py-10 lg:px-12 lg:py-10 xl:px-16'
    : 'px-8 py-8 border-t border-board-border bg-board-card';

  if (loading) return (
    <div className={pad}>
      <div className="flex items-center gap-3 text-board-subtle">
        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm">Loading task...</span>
      </div>
    </div>
  );

  if (error) return (
    <div className={pad}>
      <div className="bg-status-failed/5 border border-status-failed/15 rounded-xl px-6 py-5 text-sm text-status-failed">
        Failed to load task: {error}
      </div>
    </div>
  );

  const { task, artifacts, blueprint } = detail;

  return (
    <div className={pad} onClick={e => e.stopPropagation()}>

      {/* Title block */}
      {embedded && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-5">
            <span className={`text-[11px] font-bold px-3 py-1 rounded-md ${PRI_PILL_STYLES[task.priority] || ''}`}>
              {task.priority}
            </span>
            <span className="font-mono text-[15px] font-semibold text-accent">{task.id}</span>
            <StatusPill status={task.status} />
          </div>
          <h2 className="text-[22px] font-bold text-board-text leading-snug tracking-[-0.01em]">
            {task.title}
          </h2>
        </div>
      )}

      {/* Description */}
      <section className="mb-8">
        <SectionLabel>Description</SectionLabel>
        <p className="text-[15px] text-board-muted leading-[1.9] whitespace-pre-wrap max-w-[720px]">
          {task.description || 'No description provided.'}
        </p>
      </section>

      {/* Acceptance criteria */}
      {task.acceptance?.length > 0 && (
        <section className="mb-8">
          <SectionLabel accent>Acceptance Criteria</SectionLabel>
          <div className="bg-accent/[0.03] border border-accent/10 rounded-2xl px-7 py-6 space-y-3 max-w-[720px]">
            {Array.isArray(task.acceptance)
              ? task.acceptance.map((a, i) => (
                  <div key={i} className="flex gap-3 text-[14px] leading-relaxed text-board-muted">
                    <span className="text-accent/50 shrink-0 mt-0.5">&#x2022;</span>
                    <span>{a}</span>
                  </div>
                ))
              : <div className="text-[14px] text-board-muted">{task.acceptance}</div>
            }
          </div>
        </section>
      )}

      {/* Metadata */}
      <section className="flex flex-wrap gap-x-14 gap-y-5 mb-8">
        {task.repo_hints?.length > 0 && <MetaField label="Repos" value={task.repo_hints.join(', ')} />}
        {task.category && <MetaField label="Category" value={task.category} />}
        {(task.agentType || task.persona || task.assignee) && <MetaField label="Agent Type" value={task.agentType || task.persona || task.assignee} />}
        {task.complexity && <MetaField label="Complexity" value={task.complexity} />}
        {task.blueprint && <MetaField label="Blueprint" value={task.blueprint} />}
        {task.currentNode && <MetaField label="Current Node" value={task.currentNode} />}
        {task.currentRepo && <MetaField label="Current Repo" value={task.currentRepo} />}
        {task.assignee && <MetaField label="Assignee" value={task.assignee} />}
        {task.failCount > 0 && <MetaField label="Fail Count" value={String(task.failCount)} />}
      </section>

      {/* Timestamps */}
      {(task.createdAt || task.claimedAt || task.completedAt) && (
        <section className="flex flex-wrap gap-x-14 gap-y-5 mb-8">
          {task.createdAt && <MetaField label="Created" value={fmtTime(task.createdAt)} />}
          {task.updatedAt && <MetaField label="Updated" value={fmtTime(task.updatedAt)} />}
          {task.claimedAt && <MetaField label="Claimed" value={fmtTime(task.claimedAt)} />}
          {task.completedAt && <MetaField label="Completed" value={fmtTime(task.completedAt)} />}
        </section>
      )}

      {/* File hints */}
      {Array.isArray(task.files_hint) && task.files_hint.length > 0 && (
        <section className="mb-8">
          <SectionLabel>File Hints</SectionLabel>
          <div className="bg-board-card border border-board-border rounded-2xl px-7 py-5 space-y-2 max-w-[720px]">
            {task.files_hint.map((f, i) => (
              <div key={i} className="font-mono text-[13px] text-board-muted">{f}</div>
            ))}
          </div>
        </section>
      )}

      {/* Failure callout */}
      {task.failedNode && (() => {
        const reason = task.failureReason || '';
        const sepIdx = reason.indexOf('\n---\n');
        const plain = sepIdx >= 0 ? reason.slice(0, sepIdx).trim() : reason;
        const tech = sepIdx >= 0 ? reason.slice(sepIdx + 5).trim() : '';
        return (
          <section className="bg-status-failed/[0.05] border border-status-failed/15 rounded-2xl px-7 py-6 mb-8 max-w-[720px]">
            <div className="flex items-center gap-2.5 text-[14px] font-semibold text-status-failed mb-3">
              <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              Failed at: {task.failedNode}
            </div>
            <div className="text-[14px] text-status-failed/75 leading-relaxed whitespace-pre-line">{plain}</div>
            {tech && (
              <details className="mt-4 text-[12px] text-status-failed/55">
                <summary className="cursor-pointer font-medium hover:text-status-failed/80 select-none">Technical detail</summary>
                <div className="mt-2 whitespace-pre-line leading-relaxed font-mono">{tech}</div>
              </details>
            )}
          </section>
        );
      })()}

      {/* Pipeline */}
      {blueprint && (
        <section className="mb-8">
          <PipelineTranscript blueprint={blueprint} pipelineState={task.pipelineState} artifacts={artifacts} taskId={taskId} />
        </section>
      )}

      {/* Activity */}
      <section className="mb-8">
        <SectionLabel>Activity</SectionLabel>
        <ActivityLog notes={task.notes} />
      </section>

      {/* Actions */}
      <div className="flex items-center gap-4 pt-6 pb-[env(safe-area-inset-bottom)] border-t border-board-border flex-wrap">
        <button
          onClick={() => setEditing(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold bg-accent/10 text-accent border border-accent/15 hover:bg-accent/20 transition-all duration-150"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 19.5h-15" />
          </svg>
          Edit
        </button>

        {STUCK_STATUSES.has(task.status) && onOpenTerminal && (
          <button
            onClick={(e) => { e.currentTarget.blur(); onOpenTerminal(task.id); }}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold transition-all duration-150 ${
              terminalOpen
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-accent/10 text-accent border border-accent/15 hover:bg-accent/20'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
            {terminalOpen ? 'Close Terminal' : 'Open Terminal'}
          </button>
        )}

        {(task.status === 'FAILED' || task.status === 'AWAITING_REVIEW') && task.pipelineState?.lastSessionId && onOpenTerminal && (
          <button
            onClick={() => onOpenTerminal(task.id)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold bg-accent/10 text-accent border border-accent/15 hover:bg-accent/20 transition-all duration-150"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653z" />
            </svg>
            Resume Session
          </button>
        )}

        {STUCK_STATUSES.has(task.status) && task.failedNode && (
          <div className="flex flex-col gap-1.5">
            <button
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                setRestartMsg(null);
                try {
                  const res = await fetch(`${DEVNERDS_WEBHOOK}/restart/${task.id}/${task.failedNode}`, { method: 'POST' });
                  if (res.ok) {
                    const j = await res.json().catch(() => ({}));
                    setRestartMsg({
                      kind: 'ok',
                      text: j.message || `Restart queued — ${task.id} resuming from ${task.failedNode}. Status will update as the pipeline runs.`,
                    });
                    // Pull a fresh detail shortly so the user sees the status flip
                    // when the engine picks the task up.
                    setTimeout(refreshDetail, 1500);
                  } else {
                    const text = await res.text().catch(() => '');
                    setRestartMsg({
                      kind: 'error',
                      text: `Restart failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
                    });
                  }
                } catch (err) {
                  setRestartMsg({
                    kind: 'error',
                    text: `Restart request failed: ${err?.message || 'network error'}`,
                  });
                }
                setRestarting(false);
              }}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold bg-status-testing/10 text-status-testing border border-status-testing/15 hover:bg-status-testing/20 transition-all duration-150 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
              </svg>
              {restarting ? 'Restarting...' : `Re-run from ${task.failedNode}`}
            </button>
            {restartMsg && (
              <div className={`text-[11px] px-2 py-1 rounded ${
                restartMsg.kind === 'ok'
                  ? 'text-status-testing bg-status-testing/10'
                  : 'text-status-failed bg-status-failed/10'
              }`}>
                {restartMsg.text}
              </div>
            )}
          </div>
        )}

        {STUCK_STATUSES.has(task.status) && (
          <button
            disabled={statusUpdating}
            onClick={() => setTaskStatus('TODO')}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold bg-accent/10 text-accent border border-accent/15 hover:bg-accent/20 transition-all duration-150 disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {statusUpdating ? 'Saving...' : 'Send back to Queue'}
          </button>
        )}

        {STUCK_STATUSES.has(task.status) && (
          <button
            disabled={statusUpdating}
            onClick={() => {
              if (confirm(`Close task ${task.id}? It will move to Shipped.`)) setTaskStatus('CLOSED');
            }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold bg-status-failed/10 text-status-failed border border-status-failed/15 hover:bg-status-failed/20 transition-all duration-150 disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close Task
          </button>
        )}

        {!embedded && (
          <button onClick={onClose} className="px-6 py-3 rounded-xl text-sm font-medium border border-board-border text-board-muted hover:text-board-text hover:border-board-border-lit transition-colors">
            Close
          </button>
        )}
      </div>

      {editing && (
        <NewTaskModal
          editTask={task}
          onClose={() => setEditing(false)}
          onSaved={refreshDetail}
        />
      )}

    </div>
  );
}

function SectionLabel({ children, accent }) {
  return (
    <h3 className={`text-[11px] font-bold uppercase tracking-[0.14em] mb-5 ${accent ? 'text-accent' : 'text-board-subtle'}`}>
      {children}
    </h3>
  );
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return iso; }
}

function MetaField({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-1.5">{label}</div>
      <div className="text-[15px] font-medium text-board-text">{value}</div>
    </div>
  );
}
