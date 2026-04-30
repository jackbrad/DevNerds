export default function ActivityLog({ notes }) {
  if (!notes?.length) {
    return (
      <div className="text-[13px] text-board-subtle py-6 text-center bg-board-card/30 rounded-xl border border-board-border/50">
        No activity yet
      </div>
    );
  }

  const sorted = [...notes].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  return (
    <div className="bg-board-card/30 border border-board-border/50 rounded-xl max-h-[280px] overflow-y-auto">
      {sorted.map((note, i) => {
        const ts = note.timestamp
          ? new Date(note.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : '';
        return (
          <div key={i} className={`flex gap-3 px-5 py-3 text-[13px] ${i !== sorted.length - 1 ? 'border-b border-board-border/30' : ''}`}>
            <span className="text-board-subtle shrink-0 tabular-nums text-[12px] w-[110px]">{ts}</span>
            <span className="text-accent font-semibold shrink-0">{note.author}</span>
            <span className="text-board-muted">{note.text}</span>
          </div>
        );
      })}
    </div>
  );
}
