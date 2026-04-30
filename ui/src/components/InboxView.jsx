import { useState, useCallback } from 'react';
import StatusPill from './StatusPill';
import TaskDetail from './TaskDetail';
import WebTerminal from './WebTerminal';
import ResizeHandle from './ResizeHandle';
import { relativeTime } from '../lib/formatting';
import { PRIORITY_ORDER, STATUS_ORDER, filterTasks, PRI_PILL_STYLES, DEVNERDS_WEBHOOK } from '../lib/constants';

const MIN_LIST_W = 220;
const MAX_LIST_W = 400;

export default function InboxView({ tasks, search, priorities, categories, onRefresh }) {
  const [selectedId, setSelectedId] = useState(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [activeTab, setActiveTab] = useState('claude');
  const [listWidth, setListWidth] = useState(300);
  const [resumingId, setResumingId] = useState(null);

  const resumeTask = useCallback(async (e, task) => {
    e.stopPropagation();
    if (!task.failedNode || resumingId) return;
    setResumingId(task.id);
    try {
      const r = await fetch(`${DEVNERDS_WEBHOOK}/restart/${task.id}/${task.failedNode}`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (onRefresh) await onRefresh();
    } catch (err) {
      console.error('Resume failed:', err);
      alert(`Could not resume pipeline: ${err.message}`);
    } finally {
      setResumingId(null);
    }
  }, [resumingId, onRefresh]);

  const filtered = filterTasks(tasks, { search, priorities, categories });

  const sorted = [...filtered].sort((a, b) => {
    const p = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (p !== 0) return p;
    const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (s !== 0) return s;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  const effectiveId = selectedId && sorted.find(t => t.id === selectedId) ? selectedId : sorted[0]?.id || null;
  const selectedTask = effectiveId ? sorted.find(t => t.id === effectiveId) : null;

  const handleListResize = useCallback((delta) => {
    setListWidth(prev => Math.max(MIN_LIST_W, Math.min(MAX_LIST_W, prev + delta)));
  }, []);

  if (filtered.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-7xl mb-8 opacity-15">&#9745;</div>
          <div className="text-xl font-semibold text-board-muted">Inbox is clear</div>
          <div className="text-sm text-board-subtle mt-2">Nothing needs your attention right now</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* ── PANEL: Task list ── */}
      <div
        style={{ width: listWidth, minWidth: MIN_LIST_W, maxWidth: MAX_LIST_W }}
        className={`shrink-0 h-full overflow-y-auto bg-board-card/20 ${mobileShowDetail ? 'hidden md:block' : 'block'}`}
      >
        {sorted.map(task => {
          const selected = task.id === effectiveId;
          return (
            <div
              key={task.id}
              onClick={() => { setSelectedId(task.id); setMobileShowDetail(true); setActiveTab('claude'); }}
              className={`group cursor-pointer transition-all duration-150 border-b border-board-border/50 ${
                selected
                  ? 'bg-accent/[0.06] border-l-[3px] border-l-accent'
                  : 'border-l-[3px] border-l-transparent hover:bg-board-hover/40'
              }`}
            >
              <div className="px-4 py-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md ${PRI_PILL_STYLES[task.priority] || ''}`}>
                    {task.priority}
                  </span>
                  <span className="font-mono text-[12px] font-semibold text-accent">{task.id}</span>
                  <StatusPill status={task.status} />
                </div>
                <div className={`text-[13px] leading-snug line-clamp-2 ${selected ? 'text-board-text' : 'text-board-muted group-hover:text-board-text'} transition-colors`}>
                  {task.title}
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <div className="text-[10px] text-board-subtle tabular-nums">
                    {relativeTime(task.updatedAt || task.createdAt)}
                  </div>
                  {(task.status === 'NEEDS_ATTENTION' || task.status === 'FAILED') && task.failedNode && (
                    <button
                      onClick={(e) => resumeTask(e, task)}
                      disabled={resumingId === task.id}
                      title={`Re-enqueue from ${task.failedNode}`}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-wait transition-colors"
                    >
                      {resumingId === task.id ? 'Resuming…' : `Resume ▸ ${task.failedNode}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <ResizeHandle onDrag={handleListResize} />

      {/* ── PANEL: Tabbed work area ── */}
      <div className={`flex-1 min-w-0 h-full flex flex-col bg-[#0d1117] ${mobileShowDetail ? 'flex' : 'hidden md:flex'}`}>
        {/* Tab strip */}
        <div className="shrink-0 flex items-stretch border-b border-board-border bg-board-card">
          {mobileShowDetail && (
            <button
              onClick={() => setMobileShowDetail(false)}
              className="md:hidden flex items-center gap-2 px-4 py-3 border-r border-board-border text-accent text-sm font-semibold"
              aria-label="Back to list"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <TabButton active={activeTab === 'claude'} onClick={() => setActiveTab('claude')}>
            Claude
          </TabButton>
          <TabButton active={activeTab === 'info'} onClick={() => setActiveTab('info')}>
            Task Info
          </TabButton>
          {selectedTask && (
            <div className="flex items-center gap-2 ml-auto px-4 text-[11px] font-mono text-board-subtle">
              <span className="text-accent font-semibold">{selectedTask.id}</span>
              <span className="opacity-50">·</span>
              <span className="truncate max-w-[300px]">{selectedTask.title}</span>
            </div>
          )}
        </div>

        {/* Tab panes — keep both mounted (claude WebSocket should not remount on tab switch) */}
        <div className="flex-1 min-h-0 relative">
          {/* Claude pane */}
          <div className={`absolute inset-0 ${activeTab === 'claude' ? 'block' : 'hidden'}`}>
            {effectiveId ? (
              <WebTerminal
                key={effectiveId}
                taskId={effectiveId}
                taskTitle={selectedTask?.title || null}
                onClose={() => setActiveTab('info')}
              />
            ) : (
              <EmptyState label="Select a task to open its Claude session" />
            )}
          </div>

          {/* Task Info pane */}
          <div className={`absolute inset-0 overflow-y-auto bg-board-bg ${activeTab === 'info' ? 'block' : 'hidden'}`}>
            {effectiveId ? (
              <TaskDetail
                key={effectiveId}
                taskId={effectiveId}
                onClose={() => { setSelectedId(null); setMobileShowDetail(false); }}
                embedded
              />
            ) : (
              <EmptyState label="Select a task" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-3 text-sm font-semibold transition-colors border-b-2 ${
        active
          ? 'text-accent border-accent bg-accent/[0.04]'
          : 'text-board-muted border-transparent hover:text-board-text hover:bg-board-hover/40'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ label }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="text-5xl opacity-10 mb-4">&#x1F4CB;</div>
        <div className="text-board-subtle text-sm">{label}</div>
      </div>
    </div>
  );
}
