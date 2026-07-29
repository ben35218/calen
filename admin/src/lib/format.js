// Shared display formatting for the admin views.

export function fmtDateTime(d) {
  return d ? new Date(d).toLocaleString() : '—';
}

export function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—';
}

// Compact relative time ("2h ago") for log tables. Pair with an absolute
// tooltip (see <Timestamp>) so precision isn't lost.
export function fmtRelative(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 0) return fmtDateTime(d);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return fmtDate(d);
}
