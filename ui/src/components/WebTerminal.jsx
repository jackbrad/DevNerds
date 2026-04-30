import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { DEVNERDS_WEBHOOK } from '../lib/constants';

const WS_BASE = DEVNERDS_WEBHOOK.replace(/^http/, 'ws');

const THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#60a5fa',
  cursorAccent: '#0d1117',
  selectionBackground: '#60a5fa40',
  black: '#0d1117',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#a78bfa',
  cyan: '#22d3ee',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#c4b5fd',
  brightCyan: '#67e8f9',
  brightWhite: '#f0f6fc',
};

export default function WebTerminal({ taskId, sessionId, failedNode, taskTitle, onClose }) {
  const termRef = useRef(null);
  const termInstance = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [briefingSent, setBriefingSent] = useState(false);

  const sendBriefing = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const prompt = `Read the task briefing at /tmp/devnerds-briefings/${taskId}-briefing.md. It describes the task and its current state in the inbox. Look at the status, any pipeline context, and the artifacts, and tell me: (1) what you understand the situation to be, (2) why the task is in the inbox right now, and (3) what you propose to do about it. Then WAIT for my go-ahead before making any code changes.`;
    ws.send(prompt + '\r');
    setBriefingSent(true);
  }, [taskId]);

  const doFit = useCallback(() => {
    if (fitAddonRef.current && termInstance.current) {
      try { fitAddonRef.current.fit(); } catch { /* container not ready */ }
    }
  }, []);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(termRef.current);
    termInstance.current = term;
    fitAddonRef.current = fitAddon;

    // Initial fit after a tick (container needs to be laid out)
    requestAnimationFrame(() => {
      doFit();
      connectWs();
    });

    function connectWs() {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      if (failedNode) params.set('failedNode', failedNode);
      if (taskTitle) params.set('taskTitle', taskTitle);
      const qs = params.toString();
      const url = `${WS_BASE}/terminal/${taskId}${qs ? '?' + qs : ''}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        // Send initial size
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (evt) => {
        term.write(evt.data);
      };

      ws.onclose = () => {
        setConnected(false);
      };

      ws.onerror = () => {
        setError('Connection failed');
        setConnected(false);
      };
    }

    // Pipe keystrokes to WebSocket
    const dataDisposable = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Send resize events
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Auto-fit on container resize
    const ro = new ResizeObserver(() => doFit());
    ro.observe(termRef.current);

    // Warn before navigating away — accidental swipe/back wipes the active session.
    const beforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
      termInstance.current = null;
      fitAddonRef.current = null;
    };
  }, [taskId, doFit]);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-board-border">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 shadow-[0_0_6px_#34d399]' : 'bg-board-subtle'}`} />
          <span className="text-[11px] font-mono text-board-muted">
            {connected ? `terminal: ${taskId}` : error || 'connecting...'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {sessionId && (
            <span className="text-[10px] font-mono text-accent/60 select-all" title="claude --resume to pick up where the pipeline left off">
              session: {sessionId.slice(0, 12)}...
            </span>
          )}
          <button
            onClick={sendBriefing}
            disabled={!connected || briefingSent}
            title="Send the task briefing prompt to Claude. Otherwise the terminal stays at an empty prompt — no tokens burned on tab refresh."
            className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {briefingSent ? 'Briefing sent' : 'Start ▸ Send briefing'}
          </button>
          <button
            onClick={onClose}
            className="text-board-subtle hover:text-board-text transition-colors px-2 py-1 text-xs"
          >
            Close
          </button>
        </div>
      </div>

      {/* Terminal area */}
      <div ref={termRef} className="flex-1 min-h-0 px-1 py-1 bg-[#0d1117]" />
    </div>
  );
}
