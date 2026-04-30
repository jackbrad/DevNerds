import { useState, useEffect, useCallback } from 'react';
import FilterBar from './components/FilterBar';
import TaskList from './components/TaskList';
import InboxView from './components/InboxView';
import LiveView from './components/LiveView';
import QuipTicker from './components/QuipTicker';
import NewTaskModal from './components/NewTaskModal';
import { fetchTasks, fetchBlueprints } from './lib/api';
import { TABS, DEVNERDS_WEBHOOK } from './lib/constants';
import { apiFetch } from './auth/api-client';
import { handleSignOut } from './auth/AuthGuard';

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [blueprints, setBlueprints] = useState([]);
  const [quips, setQuips] = useState([]);
  const [activeTab, setActiveTab] = useState('inbox');
  const [search, setSearch] = useState('');
  const [priorities, setPriorities] = useState(new Set());
  const [categories, setCategories] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [triggerState, setTriggerState] = useState('idle');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const [taskData, bpData] = await Promise.all([fetchTasks(), fetchBlueprints()]);
      setTasks(taskData);
      setBlueprints(bpData);
      setLastRefresh(new Date());
      setLoadError(null);
    } catch (e) {
      console.error('Failed to load:', e);
      setLoadError(e?.message || String(e));
    }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    apiFetch('/').then(d => setQuips(d.quips || [])).catch(() => {});
  }, []);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    // Auto-refresh on tabs where DDB state moves under us — Factory (active
    // queue) and Inbox (so a Resume click surfaces the new status without a
    // manual refresh).
    if (activeTab !== 'factory' && activeTab !== 'inbox') return;
    const t = setInterval(loadData, 15000);
    return () => clearInterval(t);
  }, [activeTab, loadData]);

  const tabStatuses = new Set(TABS[activeTab]?.statuses || []);
  const tabTasks = tasks.filter(t => tabStatuses.has(t.status));
  const taskCounts = {};
  for (const [k, tab] of Object.entries(TABS)) {
    if (k === 'live') {
      taskCounts[k] = tasks.filter(t => t.status === 'IN_PROGRESS').length;
    } else {
      taskCounts[k] = tasks.filter(t => new Set(tab.statuses).has(t.status)).length;
    }
  }
  const availCats = [...new Set(tabTasks.map(t => t.category).filter(Boolean))].sort();

  function togglePriority(p) { setPriorities(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; }); }
  function toggleCategory(c) { setCategories(prev => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n; }); }

  async function handleRefresh() {
    setRefreshing(true);
    if (activeTab === 'live') {
      setRefreshKey(k => k + 1);
      await loadData();
    } else {
      await loadData();
    }
    setRefreshing(false);
  }

  async function handleTrigger() {
    setTriggerState('running');
    try { const r = await fetch(`${DEVNERDS_WEBHOOK}/trigger`, { method: 'POST' }); if (!r.ok) throw new Error(); setTriggerState('done'); setTimeout(() => setTriggerState('idle'), 3000); }
    catch { setTriggerState('error'); setTimeout(() => setTriggerState('idle'), 4000); }
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-board-bg">
        <div className="flex flex-col items-center gap-5">
          <div className="text-5xl">&#x1F913;</div>
          <div className="text-board-muted text-base font-medium tracking-wide">Loading DevNerds Factory...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {newTaskOpen && (
        <NewTaskModal
          tasks={tasks}
          onClose={() => setNewTaskOpen(false)}
          onCreated={loadData}
        />
      )}

      {/* ── HEADER ── */}
      <header className="shrink-0 bg-board-card border-b border-board-border">
        {/* Top bar */}
        <div className="px-8 lg:px-12 h-16 flex items-center gap-8">
          <button onClick={() => setMobileMenuOpen(o => !o)} className="md:hidden text-board-muted hover:text-board-text transition-colors">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex items-center gap-4 shrink-0">
            <span className="text-3xl leading-none">&#x1F913;</span>
            <h1 className="text-xl font-extrabold tracking-tight">
              <span className="text-accent">Dev</span><span className="text-board-text">Nerds</span>
            </h1>
          </div>

          <div className="flex-1 min-w-0 hidden md:block">
            <QuipTicker quips={quips} />
          </div>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="md:hidden shrink-0 p-2 -mr-2 rounded-xl text-board-muted hover:text-board-text hover:bg-board-hover transition-all"
            aria-label="Refresh"
          >
            <svg className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4.929 9a8 8 0 0113.394-2.343L20 8M19.071 15a8 8 0 01-13.394 2.343L4 16" />
            </svg>
          </button>

          {lastRefresh && (
            <span className="text-xs text-board-subtle font-mono shrink-0 tabular-nums hidden md:inline">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Nav row */}
        <div className="hidden md:flex items-center px-8 lg:px-12 h-13 gap-2 border-t border-board-border/40">
          {Object.entries(TABS).map(([key, tab]) => {
            const active = activeTab === key;
            const count = taskCounts[key] || 0;
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-3 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 ${
                  active
                    ? 'bg-accent/10 text-accent shadow-[inset_0_0_0_1px_rgba(96,165,250,0.15)]'
                    : 'text-board-muted hover:text-board-text hover:bg-board-hover'
                }`}
              >
                {tab.label}
                <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-lg min-w-[28px] text-center tabular-nums ${
                  active ? 'bg-accent/20 text-accent' : 'bg-board-border text-board-subtle'
                }`}>{count}</span>
              </button>
            );
          })}

          <div className="flex-1" />

          <button
            onClick={() => setNewTaskOpen(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25 transition-all duration-150"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Task
          </button>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-board-muted hover:text-board-text hover:bg-board-hover transition-all duration-150"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4.929 9a8 8 0 0113.394-2.343L20 8M19.071 15a8 8 0 01-13.394 2.343L4 16" />
            </svg>
            Refresh
          </button>

          <button
            onClick={handleTrigger}
            disabled={triggerState === 'running'}
            className={`flex items-center gap-2.5 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 ${
              triggerState === 'running' ? 'bg-status-progress/10 text-status-progress'
              : triggerState === 'done' ? 'bg-status-closed/10 text-status-closed'
              : triggerState === 'error' ? 'bg-status-failed/10 text-status-failed'
              : 'bg-status-closed/8 text-status-closed hover:bg-status-closed/15'
            }`}
          >
            {triggerState === 'running' && (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {triggerState === 'running' ? 'Starting...' : triggerState === 'done' ? 'Triggered' : triggerState === 'error' ? 'Offline' : 'Start Pipeline'}
          </button>

          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-board-muted hover:text-board-text hover:bg-board-hover transition-all duration-150"
            title="Sign out"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
            Sign out
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-board-border bg-board-card px-6 py-5 space-y-2">
            {Object.entries(TABS).map(([key, tab]) => (
              <button key={key} onClick={() => { setActiveTab(key); setMobileMenuOpen(false); }}
                className={`w-full flex items-center justify-between px-6 py-4 rounded-xl text-base font-semibold transition-colors ${
                  activeTab === key ? 'bg-accent/10 text-accent' : 'text-board-muted hover:bg-board-hover'
                }`}>
                {tab.label}
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-lg ${
                  activeTab === key ? 'bg-accent/20 text-accent' : 'bg-board-border text-board-subtle'
                }`}>{taskCounts[key] || 0}</span>
              </button>
            ))}
            <div className="pt-2 space-y-2">
              <button onClick={() => { setNewTaskOpen(true); setMobileMenuOpen(false); }}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl text-base font-semibold bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                New Task
              </button>
              <button onClick={() => { handleRefresh(); setMobileMenuOpen(false); }}
                disabled={refreshing}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl text-base font-semibold text-board-muted hover:bg-board-hover transition-colors">
                <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4.929 9a8 8 0 0113.394-2.343L20 8M19.071 15a8 8 0 01-13.394 2.343L4 16" />
                </svg>
                Refresh
              </button>
              <button onClick={() => { handleTrigger(); setMobileMenuOpen(false); }}
                className="w-full px-6 py-4 rounded-xl text-base font-semibold bg-status-closed/8 text-status-closed hover:bg-status-closed/15 transition-colors">
                Start Pipeline
              </button>
              <button onClick={() => { handleSignOut(); setMobileMenuOpen(false); }}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl text-base font-semibold text-board-muted hover:bg-board-hover transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ── FILTER BAR (hidden on Live tab) ── */}
      {activeTab !== 'live' && (
        <FilterBar
          search={search} onSearchChange={setSearch}
          priorities={priorities} onTogglePriority={togglePriority}
          categories={availCats} activeCategories={categories} onToggleCategory={toggleCategory}
        />
      )}

      {loadError && (
        <div className="px-6 py-3 bg-status-failed/10 border-y border-status-failed/30 text-status-failed text-sm font-medium">
          Failed to load tasks: {loadError}. Try Refresh, or Sign Out and back in.
        </div>
      )}
      {!loadError && !loading && tasks.length === 0 && (
        <div className="px-6 py-3 bg-status-testing/10 border-y border-status-testing/30 text-status-testing text-sm font-medium">
          API returned no tasks. (Auth succeeded but the response was empty.)
        </div>
      )}

      {/* ── MAIN ── */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'live' ? (
          <LiveView tasks={tasks} refreshKey={refreshKey} />
        ) : activeTab === 'inbox' ? (
          <InboxView tasks={tabTasks} search={search} priorities={priorities} categories={categories} onRefresh={loadData} />
        ) : (
          <div className="h-full overflow-y-auto">
            <TaskList tasks={tabTasks} blueprints={blueprints} search={search} priorities={priorities} categories={categories} />
          </div>
        )}
      </main>
    </div>
  );
}
