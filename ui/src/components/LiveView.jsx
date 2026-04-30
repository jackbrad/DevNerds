import { useState, useEffect, useRef } from 'react';
import { DEVNERDS_WEBHOOK } from '../lib/constants';

export default function LiveView({ tasks, refreshKey }) {
  const [logs, setLogs] = useState([]);
  const [currentNode, setCurrentNode] = useState(null);
  const [nodeHistory, setNodeHistory] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const logsEndRef = useRef(null);
  const containerRef = useRef(null);

  // Find the currently running task
  const activeTask = tasks.find(t => t.status === 'IN_PROGRESS');
  const taskId = activeTask?.id;

  useEffect(() => {
    if (!taskId) {
      setLogs([]);
      setCurrentNode(null);
      setNodeHistory([]);
      setIsConnected(false);
      return;
    }

    // Clear stale state from previous task
    setLogs([]);
    setCurrentNode(null);
    setNodeHistory([]);

    const eventSource = new EventSource(`${DEVNERDS_WEBHOOK}/stream/${taskId}`);

    eventSource.onopen = () => setIsConnected(true);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Ignore events from other tasks (stream log has mixed events)
      if (data.taskId && data.taskId !== taskId) return;

      // Per-repo events arrive as `${nodeId}:${repo}` — split for display.
      const [baseNodeId, repoFromId] = (data.nodeId || '').split(':');
      const repoName = data.currentRepo || repoFromId || null;

      if (data.type === 'log') {
        setLogs(prev => {
          const next = [...prev, { ...data, baseNodeId: baseNodeId || data.nodeId, repoName }];
          // Keep last 500 lines to avoid memory issues
          return next.length > 500 ? next.slice(-500) : next;
        });
      }

      if (data.type === 'node') {
        if (data.status === 'running') {
          setCurrentNode({ nodeId: data.nodeId, baseNodeId: baseNodeId || data.nodeId, repoName, startedAt: data.timestamp });
        } else {
          setNodeHistory(prev => [...prev, { ...data, baseNodeId: baseNodeId || data.nodeId, repoName }]);
          setCurrentNode(null);
        }
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      eventSource.close();
      setIsConnected(false);
    };
  }, [taskId, refreshKey]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  if (!activeTask) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">&#x1F4A4;</div>
          <div className="text-board-muted text-lg font-medium">No task running</div>
          <div className="text-board-subtle text-sm mt-2">Start a task to see live output here</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header bar */}
      <div className="shrink-0 px-8 lg:px-12 py-4 border-b border-board-border/40 flex items-center gap-4">
        <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-board-subtle'}`} />
        <span className="text-sm font-semibold text-board-text">{activeTask.id}</span>
        <span className="text-sm text-board-muted truncate">{activeTask.title}</span>
        <div className="flex-1" />
        {currentNode && (
          <span className="text-xs font-mono bg-accent/10 text-accent px-3 py-1 rounded-lg">
            {currentNode.baseNodeId}
            {currentNode.repoName && <span className="ml-2 text-accent/70">@ {currentNode.repoName}</span>}
          </span>
        )}
      </div>

      {/* Node progress pills */}
      {nodeHistory.length > 0 && (
        <div className="shrink-0 px-8 lg:px-12 py-3 border-b border-board-border/40 flex items-center gap-2 flex-wrap">
          {nodeHistory.map((n, i) => (
            <span key={i} className={`text-[11px] font-mono px-2.5 py-1 rounded-lg ${
              n.status === 'passed' ? 'bg-status-closed/10 text-status-closed' : 'bg-status-failed/10 text-status-failed'
            }`}>
              {n.baseNodeId}{n.repoName ? `@${n.repoName}` : ''} {n.duration ? `${n.duration.toFixed(0)}s` : ''}
            </span>
          ))}
          {currentNode && (
            <span className="text-[11px] font-mono px-2.5 py-1 rounded-lg bg-accent/10 text-accent animate-pulse">
              {currentNode.baseNodeId}{currentNode.repoName ? `@${currentNode.repoName}` : ''}...
            </span>
          )}
        </div>
      )}

      {/* Log output */}
      <div ref={containerRef} className="flex-1 overflow-y-auto bg-[#0d1117] px-6 py-4">
        {logs.length === 0 && isConnected && (
          <div className="text-board-subtle text-sm font-mono">Waiting for output...</div>
        )}
        {logs.map((entry, i) => (
          <div key={i} className="font-mono text-[12px] leading-5 text-[#c9d1d9]">
            <span className="text-[#8b949e] select-none">
              [{entry.baseNodeId}{entry.repoName ? `@${entry.repoName}` : ''}]{' '}
            </span>
            {entry.line}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
