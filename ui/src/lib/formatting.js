export function relativeTime(dateStr) {
  if (!dateStr) return '\u2014';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatCost(usd) {
  if (!usd || usd === 0) return '';
  return `$${Number(usd).toFixed(2)}`;
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

export function formatTokens(count) {
  if (!count) return '';
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}K`;
}
