const NODE_STATUS_COLORS = {
  completed: 'bg-status-closed',
  failed: 'bg-status-failed',
  active: 'bg-status-progress animate-pulse',
  pending: 'bg-board-border',
  skipped: 'bg-board-border',
};

export default function PipelineMini({ blueprint, pipelineState, currentNode }) {
  if (!blueprint?.nodes) return null;

  const allCompleted = pipelineState?.completedNodes || [];
  const completed = new Set(allCompleted);
  const failedNode = pipelineState?.failedNode;
  // currentNode may be `${baseId}:${repo}` from per-repo events; strip the suffix.
  const currentBase = (currentNode || '').split(':')[0];

  // Per-repo iterations land in completedNodes as `${baseId}:${repo}`.
  // Count how many distinct repos have entered each base node.
  const perRepoCounts = {};
  for (const entry of allCompleted) {
    const idx = entry.indexOf(':');
    if (idx === -1) continue;
    const base = entry.slice(0, idx);
    perRepoCounts[base] = (perRepoCounts[base] || 0) + 1;
  }

  return (
    <div className="flex items-center gap-1">
      {blueprint.nodes.map((node, i) => {
        const repoCount = perRepoCounts[node.id] || 0;
        let status = 'pending';
        if (completed.has(node.id) || repoCount > 0) status = 'completed';
        if (node.id === failedNode) status = 'failed';
        else if (node.id === currentBase) status = 'active';

        const title = node.for_each_repo && repoCount > 0
          ? `${node.id}: ${status} (${repoCount} repo${repoCount === 1 ? '' : 's'})`
          : `${node.id}: ${status}`;

        const dotIsCompleted = completed.has(node.id) || repoCount > 0;

        return (
          <div key={node.id} className="flex items-center">
            <div
              className={`w-2 h-2 rounded-full ${NODE_STATUS_COLORS[status]}`}
              title={title}
            />
            {i < blueprint.nodes.length - 1 && (
              <div className={`w-2 h-px ${dotIsCompleted ? 'bg-status-closed/40' : 'bg-board-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
