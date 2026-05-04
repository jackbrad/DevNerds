import { useState } from 'react';
import { ALL_PRIORITIES, PRI_ACTIVE_STYLES } from '../lib/constants';

export default function FilterBar({ search, onSearchChange, priorities, onTogglePriority, categories, activeCategories, onToggleCategory }) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const activeCount = priorities.size + activeCategories.size;

  return (
    <div className="bg-board-card/50 border-b border-board-border px-4 md:px-8 lg:px-12 py-3 md:py-4 shrink-0">
      {/* Top row: search + (mobile) filter toggle */}
      <div className="flex items-center gap-3 md:gap-6">
        <div className="relative flex-1 md:flex-initial">
          <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-board-subtle pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="bg-board-bg border border-board-border rounded-xl pl-11 pr-5 py-3 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 w-full md:w-80 placeholder:text-board-subtle transition-all"
          />
        </div>

        {/* Mobile-only filter toggle */}
        <button
          onClick={() => setMobileFiltersOpen(o => !o)}
          className={`md:hidden shrink-0 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold border transition-all duration-150 ${
            mobileFiltersOpen || activeCount > 0
              ? 'bg-accent/10 text-accent border-accent/25'
              : 'border-board-border text-board-muted hover:text-board-text hover:bg-board-hover'
          }`}
          aria-label="Toggle filters"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V19l-4 2v-7.172a1 1 0 00-.293-.707L3.293 6.707A1 1 0 013 6V4z" />
          </svg>
          {activeCount > 0 && (
            <span className="text-[11px] font-bold tabular-nums">{activeCount}</span>
          )}
        </button>

        {/* Desktop divider */}
        <div className="hidden md:block w-px h-8 bg-board-border" />

        {/* Desktop filter chips inline */}
        <div className="hidden md:flex items-center gap-2.5">
          {ALL_PRIORITIES.map(p => (
            <button
              key={p}
              onClick={() => onTogglePriority(p)}
              className={`px-4 py-2 rounded-lg text-xs font-bold border transition-all duration-150 ${
                priorities.has(p)
                  ? PRI_ACTIVE_STYLES[p]
                  : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
              }`}
            >{p}</button>
          ))}
        </div>

        {categories.length > 0 && (
          <>
            <div className="hidden md:block w-px h-8 bg-board-border" />
            <div className="hidden md:flex items-center gap-2.5 flex-wrap">
              {categories.map(c => (
                <button
                  key={c}
                  onClick={() => onToggleCategory(c)}
                  className={`px-4 py-2 rounded-lg text-xs font-medium border transition-all duration-150 ${
                    activeCategories.has(c)
                      ? 'bg-board-hover text-board-text border-board-border-lit'
                      : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
                  }`}
                >{c}</button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Mobile expanded filter chips */}
      {mobileFiltersOpen && (
        <div className="md:hidden mt-3 space-y-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">Priority</div>
            <div className="flex items-center gap-2 flex-wrap">
              {ALL_PRIORITIES.map(p => (
                <button
                  key={p}
                  onClick={() => onTogglePriority(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all duration-150 ${
                    priorities.has(p)
                      ? PRI_ACTIVE_STYLES[p]
                      : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
                  }`}
                >{p}</button>
              ))}
            </div>
          </div>
          {categories.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">Category</div>
              <div className="flex items-center gap-2 flex-wrap">
                {categories.map(c => (
                  <button
                    key={c}
                    onClick={() => onToggleCategory(c)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 ${
                      activeCategories.has(c)
                        ? 'bg-board-hover text-board-text border-board-border-lit'
                        : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
                    }`}
                  >{c}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
