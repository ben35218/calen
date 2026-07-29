// Client-side CSV download for admin tables (RFC 4180 quoting). `columns` is
// [{ label, key }] or [{ label, value: (row) => ... }].
export function downloadCsv(filename, columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    columns.map((c) => esc(c.label)).join(','),
    ...rows.map((r) =>
      columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
