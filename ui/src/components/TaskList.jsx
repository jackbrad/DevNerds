import { useState } from 'react';
import TaskRow from './TaskRow';
import TaskDetail from './TaskDetail';
import { STATUS_ORDER, PRIORITY_ORDER, filterTasks } from '../lib/constants';

export default function TaskList({ tasks, blueprints, search, priorities, categories, activeTab }) {
  const [expandedId, setExpandedId] = useState(null);
  // Factory and Shipped both default to updated-newest-first: Factory so
  // freshly-arrived tasks surface at the top, Shipped so the most-recently
  // completed work is visible first. Other tabs keep priority-first triage
  // ordering. The 'updated' branch below computes (bT - aT), so sortDir='asc'
  // here yields newest-first; flipping to 'desc' inverts to oldest-first.
  const defaultsToUpdated = activeTab === 'factory' || activeTab === 'shipped';
  const [sortField, setSortField] = useState(defaultsToUpdated ? 'updated' : 'priority');
  const [sortDir, setSortDir] = useState('asc');

  const filtered = filterTasks(tasks, { search, priorities, categories });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'priority':
        cmp = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        if (cmp === 0) cmp = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        break;
      case 'id': {
        const aNum = parseInt((a.id || '').replace(/\D/g, '')) || 0;
        const bNum = parseInt((b.id || '').replace(/\D/g, '')) || 0;
        cmp = aNum - bNum;
        break;
      }
      case 'title':
        cmp = (a.title || '').localeCompare(b.title || '');
        break;
      case 'status':
        cmp = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        break;
      case 'updated': {
        const aT = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bT = new Date(b.updatedAt || b.createdAt || 0).getTime();
        cmp = bT - aT;
        break;
      }
    }
    return sortDir === 'desc' ? -cmp : cmp;
  });

  function toggleSort(field) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function findBlueprint(task) {
    // Single pipeline — always return the first (and only) blueprint definition
    return blueprints[0] || null;
  }

  const cols = [
    { key: 'priority', label: 'Priority', width: 'w-[52px]' },
    { key: 'id', label: 'ID', width: 'w-[80px]' },
    { key: 'title', label: 'Title', width: 'flex-1' },
    { key: 'status', label: 'Status', width: 'w-[120px]' },
    { key: 'category', label: 'Category', width: 'w-[100px]' },
    { key: 'updated', label: 'Updated', width: 'w-[90px] text-right' },
  ];

  if (filtered.length === 0) {
    return (
      <div className="text-center py-24">
        <div className="text-5xl mb-4 opacity-15">&#128269;</div>
        <div className="text-sm font-medium text-board-muted">No tasks match your filters</div>
      </div>
    );
  }

  return (
    <div>
      {/* Column headers */}
      <div className="hidden md:flex items-center px-10 lg:px-16 py-3.5 border-b border-board-border text-[10px] font-bold uppercase tracking-[0.1em] text-board-subtle">
        {cols.map(col => (
          <div
            key={col.key}
            className={`${col.width} cursor-pointer px-2 py-1 rounded hover:text-board-muted hover:bg-board-hover/50 transition-colors select-none ${
              sortField === col.key ? 'text-accent' : ''
            }`}
            onClick={() => toggleSort(col.key)}
          >
            {col.label}{sortField === col.key ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}
          </div>
        ))}
      </div>

      {/* Rows */}
      <div>
        {sorted.map(task => (
          <div key={task.id}>
            <TaskRow
              task={task}
              blueprint={findBlueprint(task)}
              isExpanded={expandedId === task.id}
              onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
            />
            {expandedId === task.id && (
              <TaskDetail taskId={task.id} onClose={() => setExpandedId(null)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
