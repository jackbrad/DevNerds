import { ALL_PRIORITIES, PRI_ACTIVE_STYLES } from '../lib/constants';

export default function FilterBar({ search, onSearchChange, priorities, onTogglePriority, categories, activeCategories, onToggleCategory }) {
  return (
    <div className="bg-board-card/50 border-b border-board-border px-8 lg:px-12 py-4 shrink-0">
      <div className="flex items-center gap-6 flex-wrap">
        <div className="relative">
          <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-board-subtle pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="bg-board-bg border border-board-border rounded-xl pl-11 pr-5 py-3 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 w-80 placeholder:text-board-subtle transition-all"
          />
        </div>

        <div className="w-px h-8 bg-board-border" />

        <div className="flex items-center gap-2.5">
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
            <div className="w-px h-8 bg-board-border" />
            <div className="flex items-center gap-2.5 flex-wrap">
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
    </div>
  );
}
