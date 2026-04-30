import { STATUS_COLORS } from '../lib/constants';

const BG_MAP = {
  'status-todo': 'bg-status-todo/10 text-status-todo border-status-todo/15',
  'status-progress': 'bg-status-progress/10 text-status-progress border-status-progress/15',
  'status-awaiting': 'bg-status-awaiting/10 text-status-awaiting border-status-awaiting/15',
  'status-testing': 'bg-status-testing/10 text-status-testing border-status-testing/15',
  'status-closed': 'bg-status-closed/10 text-status-closed border-status-closed/15',
  'status-failed': 'bg-status-failed/10 text-status-failed border-status-failed/15',
  'status-blocked': 'bg-status-blocked/10 text-status-blocked border-status-blocked/15',
};

export default function StatusPill({ status }) {
  const colorKey = STATUS_COLORS[status] || 'status-todo';
  const classes = BG_MAP[colorKey] || BG_MAP['status-todo'];
  const label = (status || '').replace(/_/g, ' ');

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[10px] font-semibold border whitespace-nowrap ${classes}`}>
      {label}
    </span>
  );
}
