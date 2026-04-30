import { useState } from 'react';
import { fetchArtifactContent } from '../lib/api';
import { formatDuration, formatCost, formatTokens } from '../lib/formatting';

const VERDICT_ICONS = {
  PASSED: '\u2705', PASS: '\u2705', SHIPPED: '\u{1F680}', FIXED: '\u{1F527}',
  FAILED: '\u274C', FAIL: '\u274C', REJECTED: '\u274C', TIMEOUT: '\u23F0',
  BLOCKED: '\u{1F6D1}',
};

const TYPE_BADGES = {
  deterministic: 'bg-status-closed/8 text-status-closed border-status-closed/10',
  agentic: 'bg-accent/8 text-accent border-accent/10',
  'human-gate': 'bg-status-awaiting/8 text-status-awaiting border-status-awaiting/10',
};

export default function PipelineTranscript({ blueprint, pipelineState, artifacts, taskId }) {
  const [expandedNode, setExpandedNode] = useState(null);
  const [artifactContent, setArtifactContent] = useState({});
  const [activeArtifactTab, setActiveArtifactTab] = useState('output');
  const [loading, setLoading] = useState(false);

  if (!blueprint?.nodes) return null;

  const allCompleted = pipelineState?.completedNodes || [];
  const completed = new Set(allCompleted);
  // Per-repo iterations are recorded as `${baseId}:${repo}` — derive base ids
  // so for_each_repo nodes still light up as "completed" in the transcript.
  const completedBases = new Set(
    allCompleted
      .map(e => { const i = e.indexOf(':'); return i === -1 ? null : e.slice(0, i); })
      .filter(Boolean)
  );
  const failedNode = pipelineState?.failedNode;
  const artifactNames = new Set((artifacts || []).map(a => a.name));

  function getNodeMetrics(nodeId) {
    const output = artifactContent[`${nodeId}_output.json`];
    if (!output) return null;
    try { return JSON.parse(output); } catch { return null; }
  }

  async function loadArtifact(filename) {
    if (artifactContent[filename]) return;
    setLoading(true);
    try {
      const result = await fetchArtifactContent(taskId, filename);
      setArtifactContent(prev => ({ ...prev, [filename]: result.content }));
    } catch (e) {
      setArtifactContent(prev => ({ ...prev, [filename]: `Error loading: ${e.message}` }));
    } finally {
      setLoading(false);
    }
  }

  async function toggleNode(nodeId) {
    if (expandedNode === nodeId) { setExpandedNode(null); return; }
    setExpandedNode(nodeId);
    setActiveArtifactTab('output');
    const outputFile = `${nodeId}_output.json`;
    if (artifactNames.has(outputFile)) await loadArtifact(outputFile);
  }

  async function switchTab(nodeId, tab) {
    setActiveArtifactTab(tab);
    const fileMap = { output: '_output.json', prompt: '_prompt.md', response: '_response.json' };
    const filename = `${nodeId}${fileMap[tab]}`;
    if (artifactNames.has(filename)) await loadArtifact(filename);
  }

  return (
    <div>
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-board-subtle mb-5">
        Pipeline Transcript
      </h3>

      <div className="space-y-0.5">
        {blueprint.nodes.map((node, i) => {
          let status = 'pending';
          if (completed.has(node.id) || completedBases.has(node.id)) status = 'completed';
          else if (node.id === failedNode) status = 'failed';

          const isExpanded = expandedNode === node.id;
          const hasArtifacts = artifactNames.has(`${node.id}_output.json`);
          const metrics = isExpanded ? getNodeMetrics(node.id) : null;

          return (
            <div key={node.id}>
              <div
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-150 ${
                  hasArtifacts ? 'cursor-pointer hover:bg-board-hover/50' : ''
                } ${isExpanded ? 'bg-board-hover/50' : ''}`}
                onClick={() => hasArtifacts && toggleNode(node.id)}
              >
                {/* Status dot */}
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  status === 'completed' ? 'bg-status-closed' :
                  status === 'failed' ? 'bg-status-failed' :
                  'bg-board-border'
                }`} />

                {/* Node name */}
                <span className="font-mono text-[12px] font-medium text-board-text">{node.id}</span>

                {/* Type badge */}
                <span className={`text-[9px] font-semibold px-2 py-0.5 rounded border ${TYPE_BADGES[node.type] || ''}`}>
                  {node.type}
                </span>

                {/* Metrics */}
                {metrics && (
                  <div className="flex items-center gap-3 text-[11px]">
                    {metrics.duration_s && <span className="text-board-subtle tabular-nums">{formatDuration(metrics.duration_s)}</span>}
                    {metrics.cost_usd > 0 && <span className="text-status-awaiting tabular-nums">{formatCost(metrics.cost_usd)}</span>}
                    {metrics.tokens_in > 0 && <span className="text-board-subtle tabular-nums">{formatTokens(metrics.tokens_in)} tok</span>}
                  </div>
                )}

                {/* Expand indicator */}
                {hasArtifacts && (
                  <svg className={`w-3.5 h-3.5 text-board-subtle ml-auto transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div className="ml-9 mr-4 mt-1 mb-3">
                  {node.type === 'agentic' && (
                    <div className="flex gap-1 mb-2">
                      {['output', 'prompt', 'response'].map(tab => (
                        <button
                          key={tab}
                          onClick={(e) => { e.stopPropagation(); switchTab(node.id, tab); }}
                          className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 ${
                            activeArtifactTab === tab
                              ? 'bg-accent/10 text-accent'
                              : 'text-board-subtle hover:text-board-muted hover:bg-board-hover/50'
                          }`}
                        >
                          {tab.charAt(0).toUpperCase() + tab.slice(1)}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="bg-board-bg border border-board-border rounded-lg p-4 max-h-[400px] overflow-auto">
                    {loading ? (
                      <div className="flex items-center gap-2 text-[12px] text-board-subtle py-2">
                        <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Loading artifact...
                      </div>
                    ) : (
                      <ArtifactContent nodeId={node.id} tab={activeArtifactTab} content={artifactContent} />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ArtifactContent({ nodeId, tab, content }) {
  const fileMap = { output: '_output.json', prompt: '_prompt.md', response: '_response.json' };
  const filename = `${nodeId}${fileMap[tab]}`;
  const raw = content[filename];

  if (!raw) return <div className="text-[12px] text-board-subtle py-1">No artifact available</div>;

  if (filename.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      return (
        <pre className="text-[12px] font-mono text-board-muted whitespace-pre-wrap break-words leading-relaxed">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      return <pre className="text-[12px] font-mono text-board-muted whitespace-pre-wrap">{raw}</pre>;
    }
  }

  return <pre className="text-[12px] font-mono text-board-muted whitespace-pre-wrap break-words leading-relaxed">{raw}</pre>;
}
