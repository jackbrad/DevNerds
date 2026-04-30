import StatusPill from './StatusPill';
import PipelineMini from './PipelineMini';
import { relativeTime } from '../lib/formatting';
import { PRI_PILL_STYLES } from '../lib/constants';

export default function TaskRow({ task, blueprint, isExpanded, onClick }) {
  const updated = task.updatedAt || task.createdAt;

  return (
    <div
      className={`border-b border-board-border/60 cursor-pointer transition-all duration-150 ${
        isExpanded ? 'bg-board-hover' : 'hover:bg-board-hover/50'
      }`}
      onClick={onClick}
    >
      {/* Desktop */}
      <div className="hidden md:flex items-center px-10 lg:px-16 py-5 gap-1">
        <div className={`w-10 shrink-0 text-[10px] font-bold text-center py-0.5 rounded mr-3 ${PRI_PILL_STYLES[task.priority] || PRI_PILL_STYLES.P3}`}>
          {task.priority}
        </div>
        <div className="font-mono text-[12px] font-semibold text-accent w-[80px] shrink-0">
          {task.id}
        </div>
        <div className="flex-1 min-w-0 px-4">
          <div className="overflow-hidden whitespace-nowrap text-ellipsis text-[14px] text-board-text">
            {task.title}
          </div>
          {blueprint && (
            <div className="mt-1.5">
              <PipelineMini blueprint={blueprint} pipelineState={task.pipelineState} currentNode={task.currentNode} />
            </div>
          )}
        </div>
        <div className="w-[120px] shrink-0">
          <StatusPill status={task.status} />
        </div>
        <div className="text-[12px] text-board-subtle w-[100px] shrink-0 text-center">
          {task.category || '\u2014'}
        </div>
        <div className="text-[11px] text-board-subtle w-[90px] shrink-0 text-right tabular-nums">
          {relativeTime(updated)}
        </div>
      </div>

      {/* Mobile */}
      <div className="md:hidden px-5 py-4">
        <div className="flex items-center gap-2.5 mb-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${PRI_PILL_STYLES[task.priority] || PRI_PILL_STYLES.P3}`}>
            {task.priority}
          </span>
          <span className="font-mono text-[12px] font-semibold text-accent">{task.id}</span>
          <StatusPill status={task.status} />
          <span className="text-[11px] text-board-subtle ml-auto tabular-nums">{relativeTime(updated)}</span>
        </div>
        <div className="text-[14px] text-board-text leading-snug">{task.title}</div>
        {task.category && (
          <div className="text-[11px] text-board-subtle mt-1.5">{task.category}</div>
        )}
      </div>
    </div>
  );
}
